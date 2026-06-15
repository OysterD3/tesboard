# TeslaMate Parity & Migration

## 1. Executive summary

**What TeslaMate is.** TeslaMate is the de-facto open-source Tesla data logger: an Elixir/Phoenix application that polls a single car at high frequency (driving ≈2.5 s, charging ≈5 s, idle ≈15–30 s) over a **local** network, persists everything to a local PostgreSQL database, and visualizes it through a large suite of Grafana dashboards plus a Phoenix LiveView control UI. It owns a rich schema (`cars`, `car_settings`, `settings`, `drives`, `charging_processes`, `charges`, `positions`, `addresses`, `geofences`, `states`, `updates`, `tokens`) and a set of well-honed derivation algorithms (drive/charge sessionization, a per-car kWh/range-km efficiency factor, grid-side energy with AC-phase correction, geofence-based cost billing, battery degradation, vampire drain, reverse geocoding, sleep-aware suspend).

**What tesboard already has.** tesboard is a **read-only, never-wake-the-car** personal dashboard built on TanStack Start (React 19, SSR) deployed to Cloudflare Workers, with Supabase Postgres reached through Hyperdrive via Drizzle, and Supabase Auth (single user). It already implements the load-bearing equivalents of TeslaMate's core: a sleep-aware poller (`src/server/poller.ts`) that sessionizes `drive_session` and `charge_session`, authoritative Supercharger billing via `reconcile.ts` (`/dx/charging/history`, `cost_source = tesla_billed` vs `computed`), charge-curve reconstruction from `vehicle_snapshot`, phantom-drain insight, charging-location grouping, departure readiness, anomaly flags, and a full settings/control UI. Internally everything is stored in **miles** (`src/lib/units.ts`, `MI_PER_KM = 1/1.60934`).

**The goal.** Reach practical parity with TeslaMate's analytics and (optionally) ingest a user's existing TeslaMate history into tesboard — without abandoning the read-only, cloud, never-wake architecture.

**The architectural reality (read this first).** tesboard polls the **cloud Fleet API every 2 minutes**; TeslaMate streams **locally every ~2.5 s**. That ~50× cadence gap is the binding constraint on parity, and three TeslaMate features sit structurally beyond it and should be **explicitly de-scoped, not chased**:

1. **MQTT / real-time publishing** — there is no real-time stream to publish and no local broker; drop it.
2. **Dense, road-shaped GPS paths + per-sample drive power/elevation traces** — the 2-min poll yields a coarse breadcrumb, and `vehicle_snapshot` stores no per-sample `power`/`elevation`. A breadcrumb (optionally plus a speed trace) is the honest best case.
3. **Precise software-update install durations** — bounded by the poll cadence.

Charge-curve resolution and vampire-drain granularity are likewise capped by the cadence. Everything else — battery degradation, efficiency-vs-temperature, mileage reports, geofence billing, states timeline, multi-vehicle — is fully achievable on the data tesboard already captures or can cheaply start capturing. These limits are a deliberate consequence of the project's stated north star (read-only, never wake the car), and should be framed that way in the UI, not papered over.

---

## 2. TeslaMate feature & dashboard catalog

### Features

| Feature | What it does | Key data |
|---|---|---|
| Drive logging & trip records | Sessionizes every drive from `positions`; stores distance, duration, SOC/range deltas, energy, endpoints | `drives`, `positions` |
| Charge logging + full charge curve & cost | Sessionizes charges; per-session energy/cost/SOC + sampled curve (power/voltage/current/phases) | `charging_processes`, `charges` |
| Battery health / degradation & projected range | Capacity & range loss over life; projected range at 100% SOC | `charges`, `charging_processes`, `cars.efficiency` |
| Efficiency analysis (consumption vs temp) | Net/gross Wh/km correlated with outside temperature | `drives`, `cars.efficiency` |
| Geofences with cost-per-unit billing & session fee | Named circular zones with per-kWh/per-minute billing + session fee | `geofences` |
| Reverse-geocoded addresses | Nominatim/OSM place names for drive/charge endpoints | `addresses` |
| Software-update tracking | Firmware version history with install intervals | `updates` |
| Vehicle state / sleep tracking | online/asleep/offline state-interval timeline | `states` |
| Vampire / phantom drain | Standby loss while parked, drain rate, sleep attribution | derived from `drives`+`charging_processes`+`states` |
| Mileage & trip reports | Cumulative odometer & distance per period; Dutch-tax report | `positions`, `drives` |
| Visited locations / lifetime map | Heat/track map of all positions; visited cities/countries | `positions`, `addresses` |
| Multi-vehicle support | One instance logs all cars; `$car_id` template var, per-car MQTT | `cars` |
| MQTT realtime publishing | Live telemetry to a broker for Home Assistant etc. | live stream |
| Data import / migration & export | TeslaFi/apiscraper import; pg_dump/CSV export | all tables |
| Phoenix LiveView control UI | Live status, geofence editor, charge-cost entry, units/lang/sleep settings, token mgmt | — |

### Grafana dashboards

| Dashboard | Shows |
|---|---|
| Overview | Single-car summary: state, battery/range gauges, efficiency, mileage, recent activity |
| Drives | Table of drives (distance, duration, Wh/km, speeds, SOC) → Drive Details |
| Drive Details (internal) | One drive: GPS route + speed/power/elevation/battery/temp traces |
| Drive Stats | Aggregate driving stats over a period |
| Charges | Table of charging sessions → Charge Details |
| Charge Details (internal) | One charge: power/voltage/current vs battery % curve + temps |
| Charging Stats | Total energy/cost, cost/kWh, by location, AC vs DC |
| Charge Level | SOC over time & charge-level distribution |
| Battery Health | Capacity/range degradation, current vs original kWh, degradation % |
| Projected Range | Projected range at 100% SOC over time |
| Efficiency | Wh/km net & gross, consumption vs outside temp |
| Mileage | Cumulative odometer & distance per day/week/month/year |
| States | Timeline of online/asleep/offline/driving/charging |
| Timeline | Chronological event log of drives/charges/sleep/updates |
| Vampire Drain | Range lost while parked, drain rate, energy lost |
| Locations | Map/lists of visited addresses, cities, countries |
| Visited | Lifetime track/heat map of all GPS positions |
| Updates | Firmware version history, frequency, install duration |
| Statistics | General aggregate performance across drives/charges |
| Trip | Stats for a chosen trip/period |
| Database Information | DB size, table/row counts |
| Home (internal) | Navigation landing dashboard |
| Dutch Tax (reports) | NL business/private km tax report |

---

## 3. Feature-parity gap analysis

| Feature | Status | Effort | Priority | What's needed |
|---|---|---|---|---|
| Drive logging & trip records | **have** | S | P0 | Done: `poller.ts` sessionizes D/N/R→P into `drive_session`; surfaced by `drives.functions.ts` + `/dashboard/drives`. Caveat: energy = SOC-delta × `PACK_KWH`, coarser than TeslaMate's range-drop × efficiency; no backfill. No action. |
| GPS route map per drive | **partial** | M | P2 | Breadcrumb polyline from `vehicle_snapshot` lat/lng (`getDriveRoute`), start/end fallback when <2 fixes. Hard limit: 2-min cadence + no per-sample `power`/`elevation`. Add elevation (via elevation API) + a `speed`-vs-time trace; road-matched path and true power trace not achievable. Recommend breadcrumb + speed trace only. |
| Charge logging + summary & cost | **have** | S | P0 | Done: `charge_session` + `reconcile.ts`; `cost_source` = `tesla_billed`/`computed`; AC/DC from charger power + sustained-power reclassification. Stronger than TeslaMate on SC cost. No action. |
| Full charge curve (V/A/phases) | **partial** | M | P2 | `getChargeDetail` reconstructs power+SOC vs time from snapshots. Missing voltage/current/phases (not captured). Add `charger_voltage`/`charger_actual_current`/`charger_phases` to `vehicle_snapshot` + poller mapping; grid-side `charge_energy_used` needs V/A/phase first. Low value for a home setup. |
| Battery health / degradation & projected range | **missing** | L | **P1** | No degradation tracking. Inputs exist (`battery_range`, `usable_battery_level`, `charge_energy_added`) but uses hardcoded `PACK_KWH=75` and no capacity logic. Need: (1) per-VIN efficiency factor (modal-bucket algorithm); (2) capacity = range×eff/usable_soc, Current vs Max for degradation %; (3) `degradation.functions.ts` + UI. **Highest-value Phase-2 analytic, fully achievable on existing data.** |
| Efficiency vs outside temperature | **partial** | M | **P1** | Per-drive `wh_per_mi` stored/aggregated; `outside_temp` per snapshot. Missing the consumption-vs-temp correlation + seasonal trend. Need: join drive `wh_per_mi` to its window avg `outside_temp` + scatter/trend chart; optionally switch drive energy to range-drop × derived efficiency. High value. |
| Geofences with per-unit/session billing | **partial** | M | P2 | One home geofence (`electricity_rate.home_*` + flat rate). Missing multiple named zones, per-geofence rate, per-minute/per-session billing, `session_fee`. Need a `geofence` table, geofence matching in classify/close, a Leaflet editor, recompute pass (extend `reclassifyCharges`). |
| Reverse-geocoded addresses | **missing** | M | P2 | Only raw lat/lng or SC site names. Need an `address` cache (keyed by `osm_id`), Nominatim reverse lookup at drive/charge close (endpoints only, deduped, OSM-policy-compliant), `address_id` links. External dependency + rate limits on CF; cosmetic. |
| Software / firmware update tracking | **missing** | M | P3 | `car_version` is in the Fleet `vehicle_data` (`raw_json`) but not persisted. Need a `software_update` table + version-transition logic + Updates view. Install duration limited by cadence. Low priority. |
| Vehicle state / sleep timeline | **partial** | M | P2 | Poller is sleep-aware and stores `vehicle.last_state`, but no history table → no timeline/time-in-state. Need a `vehicle_state` interval table written on transitions + a States view. Also enables better drain attribution. |
| Vampire / phantom drain | **partial** | M | P2 | Implemented (`insights.functions.ts getPhantomDrain`) but hardcoded 7-day window, fixed 10-mi clamp, no per-period history, no sleep attribution, no cold-buffer exclusion. Need configurable windows, a drain chart, exclude `battery_level>usable_battery_level`, attribute to asleep vs awake (after states table). |
| Mileage & cumulative odometer reports | **partial** | S | P2 | Odometer per snapshot; total miles summed. Missing cumulative-odometer chart + day/week/month/year breakdown. Need a time-bucketed aggregation fn + bar/line chart. Dutch-tax split out of scope. Small. |
| Visited locations / lifetime heat map | **partial** | M | P3 | `locations.functions.ts` groups charging locations (no map). Missing a lifetime GPS track/heat map + visited cities/countries (latter needs geocoding). Need a sampled-snapshot fn + Leaflet heat/track layer. Downsampling is the main cost. Nice-to-have. |
| Multi-vehicle support | **partial** | M | P3 | Schema is VIN-keyed; every fn accepts `vinFilter`; poller iterates all cars. Gaps: no per-vehicle pack size (global `PACK_KWH=75` — CLAUDE.md's one deferral), no UI switcher, no per-vehicle model/LFP flag. Pack-size column is worth doing now (unblocks accurate efficiency/degradation). |
| MQTT realtime telemetry | **missing** | L | P3 | **Out of scope** — no real-time stream, no local broker; 2-min cadence makes a bridge pointless. **Do not pursue.** |
| Data import / migration & export | **missing** | L | P2 | No importer; no in-app export. Highest value/lowest risk: CSV/JSON export of drives/charges (S). Full TeslaMate→tesboard migration (km→mi, table mapping, regenerate `wh_per_mi`) is L, worth it only if the user has history to preserve. |
| Web control UI | **have** | S | P0 | Covered: `/dashboard/settings` (units, theme/accent, rate + loss factor + departure target, home location w/ "use car's GPS", sign-out); `account.functions` for Tesla link/resync; overview shows live-ish status. Gaps: geofence editor (see Geofences), manual per-session cost override (optional, S). At parity for a read-only app. |
| Aggregate statistics dashboards (Stats / Charging Stats / Drive Stats / Charge Level) | **partial** | M | **P1** | Good aggregates already (charging/drive stats, insights projections). Missing time-series/period charts beyond the charge curve: no SOC-over-time, no efficiency trend, no cost-per-period trend, no custom date ranges. Need a small charting layer for time-bucketed series + a date-range picker wired into the server fns. **Broadest UX gap;** pairs with efficiency + mileage work. |

### Scope recommendation

tesboard already has genuine parity on the load-bearing features for a personal read-only dashboard. The real gaps are **analytics depth** and a handful of **telemetry fields** — not core plumbing.

**Do first, regardless of wave:** add the per-VIN pack-size / derived-efficiency column. It is the lynchpin that makes drive energy, efficiency-vs-temp, and degradation all correct, and it closes the project's only acknowledged deferral (`PACK_KWH=75`).

- **P1 wave (best value-per-effort, all on existing data):** (1) per-VIN efficiency factor + battery health/degradation; (2) efficiency-vs-temperature + a reusable time-series charting layer with a date-range picker (also fixes linear-projection and "no custom range"); (3) mileage/cumulative-odometer view riding the new charting layer.
- **P2 wave (functional / QoL):** CSV/JSON export (start here — trivial, high utility); multi-geofence support with a Leaflet editor + per-geofence rate; a `vehicle_state` history table (States/Timeline + better drain attribution); harden phantom-drain (configurable window, cold-buffer exclusion). Add charger V/A to snapshots only if richer charge detail is wanted.
- **P3 / defer:** reverse-geocoded addresses (external dep, cosmetic), lifetime heat map, firmware-update tracking, full multi-vehicle UI, and the TeslaMate-history importer (only if the user actually has history to migrate — note km→mi).
- **Drop entirely:** MQTT.

---

## 4. Migration design

### Ingest strategy + rationale

**Chosen strategy:** a **server-side parsed, chunked, resumable upload of a TeslaMate PostgreSQL CSV-per-table export**, driven from the Settings page. The user runs the TeslaMate-blessed `\copy`/`pg_dump --table`→CSV export, producing one CSV per table (`cars`, `car_settings`, `settings`, `geofences`, `addresses`, `drives`, `charging_processes`, `charges`, `positions`, `states`, `updates`). tesboard's Settings adds an "Import from TeslaMate" panel that uploads these to a new server function. Small tables are parsed and ingested in-request; the two huge time-series tables (`positions`, `charges`) are uploaded separately and ingested **page-by-page** (the server fn takes an offset/cursor; the browser re-calls until done). All writes land in **staging tables keyed by `import_batch_id` + the original TeslaMate integer PK**, then a finalize step remaps PKs → tesboard identity PKs and upserts into live tables with set-based SQL over Hyperdrive.

**Why this and not the obvious alternatives** (Cloudflare Workers constraints force the design):

- **Rejected — Worker pulls from a user-supplied read-only Postgres connection string.** TeslaMate Postgres is typically LAN/NAT-bound and unreachable from a Worker; raw postgres-js TCP **hangs in workerd** (the project already routes its own DB through Hyperdrive for exactly this reason); it would require storing user DB credentials; and a long-lived second connection conflicts with request-scoped Worker I/O.
- **Rejected — upload a `pg_dump` and replay it.** Postgres-dialect SQL (`COPY`/`SET`/`OWNER`/sequences/encrypted `bytea` for `private.tokens`) cannot be safely replayed as the app user into Supabase; COPY-format parsing in a Worker is brittle; it drags in tables we explicitly skip. CSV-per-table is the same data in a trivially parseable RFC4180 format and lets us skip what we don't want.
- **Rejected — standalone CLI against both DBs.** Cleanest data-wise but forces the user to run local tooling with both the TeslaMate DSN and tesboard's privileged `DIRECT_URL`, abandons the in-app UX, and adds a separate artifact to maintain.
- **Rejected — single-request whole-file parse-and-insert.** Exceeds Worker CPU/memory/duration and Hyperdrive limits on `positions`/`charges`; not resumable; no progress feedback.
- **Rejected — direct insert into live fact tables without staging.** Makes PK remapping and the `drives`↔`positions` / `charges`↔`charging_processes` circular-FK rewrite impossible to do safely mid-stream and breaks idempotency/rollback. Staging by `(import_batch_id, old_pk)` is required.

The result is viable under Worker limits, needs no inbound network to the user's DB, stores no DB creds, is resumable + idempotent, and matches the codebase's existing Hyperdrive + cursor conventions (`tesla_charging_history_import` already establishes the cursor/resume pattern).

### Table-by-table mapping

| TeslaMate → tesboard | Mapping highlights |
|---|---|
| `cars` → **`vehicle`** | **`vin` is the natural key** — match the single user's existing `vehicle.vin`, UPDATE metadata, reuse the PK; never create a duplicate. `name`→`display_name`, `model`→`model`/`car_type`, `vid`→`vehicle_id` (stringify), `efficiency` (kWh/km)→`efficiency_wh_per_mi` (×1000×1.60934), plus new `trim`/`marketing_name`/`exterior_color`/`wheel_type`/`spoiler_type`. `cars.id`→`import_pk_map(entity='car', new_vin)`. `user_id` stamped from `getSessionUser()`. Persist `efficiency` — it back-converts range deltas into imported-drive energy. |
| `car_settings` → **`vehicle`** (+ rate hint) | `lfp_battery`→`vehicle.is_lfp`; `free_supercharging`→makes imported SC sessions `cost_amount=0`, `cost_source='tesla_billed_free'` (+ optional `vehicle.free_supercharging`). Operational fields (suspend/streaming/enabled) dropped. Join 1:1 via `cars.settings_id`. |
| `settings` → **read-only sentinel** | **Not imported as a row.** `unit_of_*` are display-only on both sides — **TeslaMate storage is always metric**, so always convert km→mi etc. and ignore `unit_of_length`. Only `preferred_range` (`rated`\|`ideal`) changes mapping (which range column is authoritative). Capture `preferred_range` into the import batch for consistency. |
| `geofences` → **new `geofence`** (+ home rate) | `name` (natural key), `latitude`/`longitude`→`lat`/`lng`, `radius`(m)→`radius_m`, `billing_type`, `cost_per_unit`, `session_fee`, `currency`. The geofence the user designates Home seeds `electricity_rate.home_*` + `flat_rate` **only if still unset** (don't clobber). `id`→`import_pk_map(entity='geofence')`. |
| `addresses` → **new `address`** | Natural key `(osm_id, osm_type)` UNIQUE (matches TeslaMate's own dedup). Copy `display_name`, `name`/`house_number`/`road`/`neighbourhood`/`city`/`county`/`postcode`/`state`/`state_district`/`country`, `latitude`→`lat`, `longitude`→`lng`, `raw`→`raw_json`, remapped `geofence_id`. `id`→`import_pk_map(entity='address')`. Upsert so re-import is a no-op. |
| `drives` → **`drive_session`** | `start_date`→`started_at`, `end_date`→`ended_at` (treat as UTC, append `Z`); `start_km`/`end_km`→odometer×0.621371; `distance`→`distance_mi`×0.621371; `duration_min`→`duration_s`×60; `speed_max`→`speed_max_mph`×0.621371; `power_max`/`power_min` kW (no change); SOC pass-through; `*_range_km`→`start_range_mi`/`end_range_mi`×0.621371 (per `preferred_range`); **`energy_used_kwh` = range-delta × `cars.efficiency`** (TeslaMate has no per-drive kWh); `wh_per_mi` = energy×1000/distance (guard, NULL on reduced-range); temps °C pass-through; `ascent`/`descent` m; endpoints→remapped `start_snapshot_id`/`end_snapshot_id`; address/geofence FKs remapped; `car_id`→`vin`. Idempotency key `(vin, started_at)`. Set `import_source='teslamate'` + `source_pk` so the poller never re-sessionizes over it. |
| `charging_processes` → **`charge_session`** | `start_date`/`end_date`→`started_at`/`ended_at`; `charge_energy_added`→`energy_added_kwh` (**kWh, no conversion**); `charge_energy_used`→`energy_used_kwh`; `cost`→`cost_amount` with `cost_source='tesla_billed'` (SC) or `'imported_teslamate'`; SOC; `*_range_km`→`miles_added_rated` + `start/end_range_mi`×0.621371; `outside_temp_avg`→`outside_temp_c`; AC/DC `source`/`charge_location_type` from child `fast_charger_type` + geofence; `position_id`→copied lat/lng + `address_id`; geofence/address remapped; `car_id`→`vin`. Idempotency `(vin, started_at)`. `tesla_charge_session_id` stays NULL → no collision with the existing partial-unique. **Don't scale `energy_added_kwh`.** |
| `charges` → **`vehicle_snapshot`** (curve samples) | tesboard has **no dedicated charge-sample table** — the charge curve is reconstructed from `vehicle_snapshot`. So `charges` rows import into `vehicle_snapshot`: `date`→`recorded_at`, `battery_level`, `usable_battery_level`, `charger_power` (kW), `charge_energy_added` (kWh), new `charger_voltage`/`charger_actual_current`/`charger_phases`, `*_range_km`→`battery_range`×0.621371, `outside_temp` (°C), synthesize `charging_state='Charging'`; `charging_process_id`→sets lat/lng from parent position + `source_charge_id`. Tag `import_source` so they aren't re-sessionized. Big table → chunked. |
| `positions` → **`vehicle_snapshot`** (GPS + telemetry) | The drive-route UI pulls breadcrumb from `vehicle_snapshot`, so `positions` import there: `date`→`recorded_at`, lat/lng, `odometer`→×0.621371, `speed`→mph×0.621371, new `power_kw`, `battery_level`/`usable`, `*_range_km`→`battery_range`×0.621371, `est_battery_range_km`→×0.621371, `outside_temp`/`inside_temp` (°C), new `elevation_m`, `tpms_*` (**bar, no change**); climate fields → `raw_json` or dropped (tesboard doesn't surface them — keep row size down). `drive_id`→`source_drive_id`. Biggest table → must be chunked; consider downsampling. |
| `states` → **new `vehicle_state`** | `state`→`state`, `start_date`→`started_at`, `end_date`→`ended_at`, `car_id`→`vin`. Idempotency `(vin, started_at)`. |
| `updates` → **new `software_update`** | `version`, `start_date`→`started_at`, `end_date`→`ended_at`, `car_id`→`vin`. Idempotency `(vin, started_at, version)`. |
| `tokens` (`private.tokens`) → **SKIP** | AES-encrypted under TeslaMate's vault key (not portable), in the `private` schema, and refresh tokens rotate (stale). User re-runs `/api/auth/tesla/login`. **Never import.** |

### Unit conversions

| Quantity | Rule |
|---|---|
| Distance / odometer (km→mi) | × **0.621371** (= /1.609344). `drives.distance`, `start_km`/`end_km`, `positions.odometer`. Reuse `MI_PER_KM` from `src/lib/units.ts`. |
| Range (km→mi) | × 0.621371 for **all** `*_battery_range_km` (rated/ideal/est) across `drives`/`charging_processes`/`charges`/`positions`. Pick rated vs ideal per `settings.preferred_range`; tesboard stores one range figure. |
| Speed (km/h→mph) | × 0.621371. `positions.speed`, `drives.speed_max`. Store mph (miles-internal convention); document the unit. |
| Temperature (°C) | **No conversion** — canonical storage is Celsius on both sides; UI converts. `outside_temp`, `inside_temp`, `*_temp_avg`, temp setpoints pass through. |
| Tire pressure (bar) | **No conversion** — both store bar. `tpms_pressure_*` pass through. |
| Energy (kWh) | **No conversion** — `charge_energy_added`/`charge_energy_used` are kWh both sides. **Trap: do not scale by a distance factor.** |
| Power (kW) | **No conversion** — `charger_power`, `positions.power`, `drives.power_max/min`. |
| Voltage (V) / Current (A) | **No conversion.** |
| Elevation / ascent / descent (m) | **No conversion at storage** — store metres in `*_m` columns; convert to ft at render only (1 m = 3.28084 ft). |
| Wh/mi (efficiency) | **Derived, not converted:** `wh_per_mi = energy_used_kwh×1000 / distance_mi`, where `energy_used_kwh = range_delta_km × cars.efficiency`. Equivalent: `wh_per_mi = (range_delta_km × efficiency × 1000)/(distance_km × 0.621371)`. Guard divide-by-zero; NULL on reduced-range/negative. |
| Timestamps | TeslaMate stores naive UTC; tesboard uses `timestamptz` mode `'string'`. Treat the value as UTC and append `Z` / format ISO-8601 UTC. No timezone math. |

### ID remapping

TeslaMate uses `bigserial` integer PKs everywhere; tesboard uses (a) `vin` (text) for `vehicle`, (b) `generatedAlwaysAsIdentity` bigint for `vehicle_snapshot`/`charge_session`/`drive_session`/`anomaly_flag`, and (c) `user_id` (uuid) for singletons. Bridge with one ephemeral table:

```
import_pk_map(import_batch_id, entity, old_id bigint, new_id bigint NULL, new_vin text NULL,
              UNIQUE(import_batch_id, entity, old_id))
```

Algorithm, in dependency order:

1. **cars** → match `cars.vin` to `vehicle.vin` (upsert); record `(entity='car', old_id=cars.id, new_vin=vin)`. All child `car_id` lookups resolve to `vin`.
2. **geofences** → new `geofence` (INSERT or match by `(user_id, lower(name))`/proximity); capture identity `new_id` into `pk_map(entity='geofence')`.
3. **addresses** → new `address` keyed by `(osm_id, osm_type)`; upsert; capture `new_id` into `pk_map(entity='address')`.
4. **drives** → `drive_session` (car→vin, address/geofence via pk_map, snapshot ids left NULL); capture `pk_map(entity='drive')`. Likewise **charging_processes** → `charge_session`, capture `pk_map(entity='charging_process')`.
5. **positions** → `vehicle_snapshot` in chunks, setting `source_drive_id = pk_map(drive, positions.drive_id).new_id`; capture `pk_map(entity='position', old_id, new_id=snapshot.id)`.
6. **charges** → `vehicle_snapshot` in chunks, setting `source_charge_id = pk_map(charging_process, charges.charging_process_id).new_id`.
7. **Backfill circular FKs:** `drives.start/end_position_id` → `drive_session.start/end_snapshot_id` via `pk_map(entity='position')`; `charging_processes.position_id` → lat/lng on `charge_session`.

Because tesboard identity columns are `generatedAlwaysAsIdentity`, **capture the returned id (`INSERT … RETURNING id`)** rather than supplying it. `import_pk_map` is scoped by `import_batch_id` and can be pruned after finalize.

### Idempotency

Re-import must be a no-op (or safe update):

1. Every imported fact row gets `import_source text DEFAULT 'live'` (set `'teslamate'` on import) + `source_pk bigint` (original TeslaMate id).
2. Partial UNIQUE indexes on the business keys: `drive_session (vin, started_at) WHERE import_source='teslamate'`; `charge_session (vin, started_at) WHERE import_source='teslamate'` (distinct from the existing `tesla_charge_session_id` unique, which stays NULL for imports); `vehicle_snapshot (vin, recorded_at)` for imported rows; `vehicle_state (vin, started_at)`; `software_update (vin, started_at, version)`; `geofence (user_id, lower(name))`; `address (osm_id, osm_type)`.
3. Finalize issues `INSERT … ON CONFLICT (business key) DO NOTHING` (facts) / `DO UPDATE` (metadata: vehicle, geofence, address).
4. An `import_batch` table (id, user_id, status, created_at, file checksums, row counts, cursor offsets per table) makes the whole import resumable and lets a re-uploaded identical export detect "already imported" via checksum.
5. **Keep imported and poller-generated data from overlapping:** the poller/sessionizer must **not** re-sessionize over `vehicle_snapshot` rows where `import_source='teslamate'`, and `reconcile.ts` must **not** overwrite `charge_session.cost` where `cost_source IN ('imported_teslamate','tesla_billed_free')`.
6. Because live data may overlap the cutover, import only rows with `started_at < first_live_poll_at` **or** rely on `(vin, started_at)` uniqueness to dedupe the seam (open question below).

### Required new tesboard schema (from migration)

New columns on `vehicle`, `drive_session`, `charge_session`, `vehicle_snapshot`, and new tables `geofence`, `address`, `vehicle_state`, `software_update`, `import_batch`, `import_pk_map` — consolidated in §5.

---

## 5. Required tesboard schema changes (consolidated, Drizzle-flavored)

All edits in `src/server/schema.ts`; mirror into `src/types/db.ts`; then `pnpm db:generate` → review `drizzle/000N_*.sql` → `pnpm db:migrate` (via `DIRECT_URL`, bypassing Hyperdrive). **Every new table must `.enableRLS()` with no policies and carry `user_id`** (app-enforced-user_id model); every importer/server-fn query filters by `user_id`.

- **`vehicle` — add:** `model text`, `trim text`, `marketing_name text`, `exterior_color text`, `wheel_type text`, `spoiler_type text`, `pack_kwh numeric({mode:'number'})`, `efficiency_wh_per_mi numeric({mode:'number'})` (nullable derived factor; `= cars.efficiency × 1000 × 1.60934`), `is_lfp boolean default false`, `free_supercharging boolean default false`, `display_priority integer default 1`. *(Replaces the `PACK_KWH=75` constant — CLAUDE.md's one deferral.)*
- **`drive_session` — add:** `start_range_mi`/`end_range_mi doublePrecision`, `outside_temp_avg`/`inside_temp_avg doublePrecision` (°C), `speed_max_mph integer` (mph), `power_max_kw`/`power_min_kw integer`, `ascent`/`descent integer` (m), `start_snapshot_id`/`end_snapshot_id bigint` FK→`vehicle_snapshot.id`, `start_address_id`/`end_address_id bigint` FK→`address.id`, `start_geofence_id`/`end_geofence_id bigint` FK→`geofence.id`, `import_source text default 'live'`, `source_pk bigint`. **Partial UNIQUE(`vin`, `started_at`) WHERE `import_source='teslamate'`.**
- **`charge_session` — add:** `energy_used_kwh doublePrecision` (grid-side, ≥ added), `start_range_mi`/`end_range_mi doublePrecision`, `start_battery_level`/`end_battery_level integer`, `outside_temp_avg doublePrecision` (°C), `fast_charger_type text`, `address_id bigint` FK→`address.id`, `geofence_id bigint` FK→`geofence.id`, `import_source text default 'live'`, `source_pk bigint`. Accept `'imported_teslamate'` and `'tesla_billed_free'` as `cost_source` values. **Partial UNIQUE(`vin`, `started_at`) WHERE `import_source='teslamate'`.**
- **`vehicle_snapshot` — add:** `charger_voltage integer`, `charger_actual_current integer`, `charger_phases integer`, `power_kw doublePrecision`, `elevation_m integer`, `source_drive_id bigint` (→`drive_session.id`), `source_charge_id bigint` (→`charge_session.id`), `import_source text default 'live'`, `source_pk bigint`. Index on `(source_drive_id)` and `(source_charge_id)` (route/curve queries). Optional UNIQUE(`vin`, `recorded_at`) for imported rows.
- **NEW `geofence`** — `id` identity PK, `user_id uuid`, `name text notNull`, `lat`/`lng doublePrecision`, `radius_m numeric default 150`, `billing_type text default 'per_kwh'` (`per_kwh`|`per_minute`|`per_session`), `cost_per_unit numeric`, `session_fee numeric`, `currency text`, `source_pk bigint`, `created_at`/`updated_at`. `.enableRLS()`; **UNIQUE(`user_id`, lower(`name`))**; index on `user_id`. Generalizes the single home geofence in `electricity_rate`.
- **NEW `address`** — `id` identity PK, `user_id uuid`, `osm_id bigint`, `osm_type text`, `display_name text`, `name`/`house_number`/`road`/`neighbourhood`/`city`/`county`/`postcode`/`state`/`state_district`/`country text`, `lat`/`lng doublePrecision`, `raw_json jsonb`, `geofence_id bigint` FK, `source_pk bigint`, `created_at`. `.enableRLS()`; **UNIQUE(`osm_id`, `osm_type`)** (partial, where `osm_id` not null).
- **NEW `vehicle_state`** — `id` identity PK, `vin text` FK→`vehicle`, `user_id uuid`, `state text` (`online`|`asleep`|`offline`|`driving`|`charging`), `started_at timestamptz notNull`, `ended_at timestamptz`, `source_pk bigint`. `.enableRLS()`; index `(vin, started_at desc)`; **partial UNIQUE(`vin`) WHERE `ended_at` IS NULL** (one open interval per car); **UNIQUE(`vin`, `started_at`)**. Powers States timeline + drain attribution.
- **NEW `software_update`** — `id` identity PK, `vin text` FK→`vehicle`, `user_id uuid`, `version text`, `started_at timestamptz`, `ended_at timestamptz`, `source_pk bigint`, `created_at`. `.enableRLS()`; **UNIQUE(`vin`, `started_at`, `version`)**.
- **NEW `import_batch`** — `id` identity PK, `user_id uuid`, `status text`, `source text default 'teslamate'`, `preferred_range text`, `file_checksums jsonb`, `cursors jsonb`, `row_counts jsonb`, `error text`, `created_at`, `finished_at`. `.enableRLS()`. Drives resumability + re-upload dedupe.
- **NEW (transient) `import_pk_map`** — `import_batch_id bigint`, `entity text`, `old_id bigint`, `new_id bigint`, `new_vin text`, **UNIQUE(`import_batch_id`, `entity`, `old_id`)**. Old-PK → new-identity bridge during a batch; prunable after finalize.

---

## 6. Phased implementation plan

Waves are DAG-ordered. Each wave ends with `pnpm test` + a typecheck/`vite build`; the final wave adds `wrangler deploy --dry-run`. Migrations: `pnpm db:generate` → review → `pnpm db:migrate` (`DIRECT_URL`).

### Wave 0 — Schema foundation *(depends on: none)*
Extend the Drizzle schema with every column/table for parity **and** the importer — additive, RLS-enabled, `user_id`-scoped; no behavior change. Unblocks everything.
- Add per-vehicle physical attributes to `vehicle` (`model`, `trim`, `marketing_name`, `pack_kwh`, `efficiency_wh_per_mi`, `is_lfp`/`lfp_battery`, `display_priority`) — replaces `PACK_KWH=75`.
- Add the drive aggregate columns to `drive_session`, charge aggregate/curve columns to `charge_session`, and curve/telemetry columns to `vehicle_snapshot` (§5).
- Create `geofence`, `address`, `vehicle_state`, `software_update` (and the importer's `import_batch`/`import_pk_map` if landing Wave 1 immediately) — all `.enableRLS()`, `user_id`-carrying, with the §5 indexes.
- Add `import_source`/`source_pk` + partial unique indexes to `vehicle_snapshot`/`charge_session`/`drive_session`.
- Mirror every change into `src/types/db.ts`; `pnpm db:generate` → review → `pnpm db:migrate`. Run `pnpm test` + `vite build`.
- **Files:** `src/server/schema.ts`, `src/types/db.ts`, `drizzle/` (generated), `drizzle/meta/`.

### Wave 1 — TeslaMate → tesboard importer *(depends on: Wave 0)*
One-shot, idempotent, VIN-keyed importer (independently shippable behind a flag).
- `src/server/import/teslamate-import.ts`: parse uploaded CSVs (or read a source DB in the CLI variant), ingest in DAG order cars→geofences→addresses→charging_processes→drives→positions(→`vehicle_snapshot`)→charges→states→updates, using `import_pk_map` for FK rewrite and `INSERT … RETURNING id` for identity capture.
- `src/server/import/teslamate-map.ts`: pure mapping/conversion helpers (km→mi, kWh/km→Wh/mi, cost-source, AC/DC classification).
- CLI wrapper `scripts/import-teslamate.mjs` (mirrors `create-user.mjs` style): `node scripts/import-teslamate.mjs <userEmail> [--positions]`; resolves `user_id` via admin API; prints per-table summary. Add `import:teslamate` to `package.json`; document `TESLAMATE_DATABASE_URL` in `.env.example`.
- **Tests:** unit-test the pure mapping fns; an integration test seeding a tiny TeslaMate-shaped fixture asserting idempotent re-run inserts zero new rows (real ephemeral Postgres, no DB mocks).
- **Files:** `src/server/import/teslamate-import.ts`, `src/server/import/teslamate-map.ts`, `src/server/import/teslamate-map.test.ts`, `scripts/import-teslamate.mjs`, `package.json`, `.env.example`.

### Wave 2 — Geofences + reverse geocoding + geofence-based billing *(depends on: Wave 0)*
- `src/server/geocode.ts`: Nominatim `/reverse` (jsonv2, zoom 19, descriptive User-Agent), map to `address`, dedupe on `(osm_id, osm_type)`, OSM-policy-compliant (endpoints only, cache+reuse), `NOMINATIM_BASE_URL` configurable.
- Extend `src/server/geo.ts` with `findGeofence(lat,lng,geofences)` (nearest-wins haversine within radius, reuse `haversineMeters`).
- `src/server/cost.ts`: `computeChargeCost(...)` implementing TeslaMate's order — free-SC→0; per_kwh→MAX(added,used)×rate+fee; per_minute→duration×rate+fee; else null; flat home rate as fallback.
- Wire into `src/server/poller.ts` close handlers (set `geofence_id`/cost via `computeChargeCost`; best-effort reverse-geocode endpoints; pass `db` down, never cache).
- `src/functions/geofences.functions.ts` (get/upsert/delete, authMiddleware + `user_id`); migrate the single home geofence into a seeded "Home" row.
- UI `src/routes/dashboard/geofences.tsx` (Leaflet editor) + nav entry; extend `reclassifyCharges` to retro-recost after a rate edit.
- **Tests:** `findGeofence` (nearest-wins, just-outside), `computeChargeCost` (all branches + free-SC), geocode mapper vs captured fixture (no live HTTP).
- **Files:** `src/server/geocode.ts`, `src/server/cost.ts`, `src/server/geo.ts`, `src/server/poller.ts`, `src/functions/geofences.functions.ts`, `src/functions/rate.functions.ts`, `src/routes/dashboard/geofences.tsx`, `src/routes/dashboard.tsx`, `src/server/geo.test.ts`, `src/server/cost.test.ts`.

### Wave 3 — Per-vehicle efficiency factor + states + updates (poller-side) *(depends on: Wave 0)*
- `src/server/efficiency.ts`: `recalculateEfficiency(db, vin, userId)` — TeslaMate's modal-factor algorithm over `charge_session` (filter duration>10 min, end SOC ≤95, energy>0; bucket `energy_added/(end_range_mi−start_range_mi)`; modal pick with retry pairs `[{5,8},{4,5},{3,3},{2,2}]`). Store to `vehicle.efficiency_wh_per_mi`; call after `closeChargeSession`.
- Update `poller.ts` drive-energy math to use per-vehicle `pack_kwh`/efficiency instead of `PACK_KWH=75` (range-delta × efficiency, fallback to pack×SOC-delta). Removes the CLAUDE.md deferral.
- Add `vehicle_state` tracking (close prior interval / open new on transition; guard via partial unique, ignore 23505 like the existing session pattern) and `software_update` detection (read `car_version`; on change close prior + insert, idempotent via `(vin,version)`).
- `src/functions/states.functions.ts` (timeline + time-in-state) and `src/functions/updates.functions.ts` (version history), authMiddleware + `vinFilter` + `user_id`.
- **Tests:** `recalculateEfficiency` over fixtures (modal selection + threshold fallback); a pure state-transition reducer test (online→driving→charging→asleep → correct intervals).
- **Files:** `src/server/efficiency.ts`, `src/server/poller.ts`, `src/server/efficiency.test.ts`, `src/functions/states.functions.ts`, `src/functions/updates.functions.ts`.

### Wave 4 — Battery health, projected range & efficiency-vs-temperature *(depends on: Wave 0, Wave 3)*
- `src/functions/battery.functions.ts`: `getBatteryHealth` (capacity = range_mi×eff/usable_soc; Current = avg over recent charges, Max = historical max; degradation% = GREATEST(0,100−Current×100/MaxOrOverride); rated-range-at-100% series) + `getProjectedRange`.
- `src/functions/efficiency-analysis.functions.ts`: `getEfficiencyAnalysis` (per-period Wh/mi net/gross + consumption-vs-`outside_temp_avg` scatter), `user_id`-scoped.
- UI `src/routes/dashboard/battery.tsx` and `src/routes/dashboard/efficiency.tsx` (reuse `buildChart` SVG primitive; respect `useDash()` unit toggles) + nav; a `$custom_kwh_new`/`$custom_max_range`-style override input for "new capacity".
- **Tests:** degradation & projected-range builders in `src/lib/analytics-vm.ts` with fixtures; assert reduced-range exclusion (`battery_level>usable` → NULL consumption).
- **Files:** `src/functions/battery.functions.ts`, `src/functions/efficiency-analysis.functions.ts`, `src/lib/analytics-vm.ts`, `src/lib/analytics-vm.test.ts`, `src/routes/dashboard/battery.tsx`, `src/routes/dashboard/efficiency.tsx`, `src/routes/dashboard.tsx`.

### Wave 5 — Mileage, States/Timeline/Updates dashboards & lifetime map *(depends on: Wave 0, Wave 3)*
- `src/functions/mileage.functions.ts`: `getMileage` (cumulative odometer + distance per day/week/month/year) + `getTripReport` (date-range stats). `user_id` + `vinFilter`.
- `src/functions/timeline.functions.ts`: `getTimeline` (UNION of drives/charges/state transitions/updates into a chronological log); reuse `getStates`.
- UI routes: `mileage.tsx`, `states.tsx` (state-timeline bar), `timeline.tsx` (event log), `updates.tsx` (version history) + nav.
- Extend `locations.tsx` (or add `visited.tsx`) with a Leaflet heat/track layer over sampled `vehicle_snapshot` GPS (cap + downsample). Extend `insights.functions.ts` with a Statistics/Trip aggregate.
- **Tests:** mileage period-bucketing and timeline-merge ordering as pure fns (sorted, no dup overlaps).
- **Files:** `src/functions/mileage.functions.ts`, `src/functions/timeline.functions.ts`, `src/functions/insights.functions.ts`, `src/routes/dashboard/{mileage,states,timeline,updates,visited,locations}.tsx`, `src/components/dashboard/LeafletMap.tsx`, `src/routes/dashboard.tsx`, `src/lib/analytics-vm.test.ts`.

### Wave 6 — Multi-vehicle support *(depends on: Wave 0, 3, 4, 5)*
- `src/functions/vehicles.functions.ts`: `getVehicles` (list with `display_name`/`model`/`marketing_name`/`last_state`, ordered by `display_priority`).
- Vehicle switcher in the dashboard shell (`src/routes/dashboard.tsx`) backed by `?vin=`; persist active vin in `DashboardProvider`/localStorage; default to highest-priority.
- Audit every loader + server fn to thread the active `vin` through `vinFilter` (they already accept it); confirm battery/efficiency/mileage/states/timeline/updates/map honor it. Confirm per-vehicle `pack_kwh`/`efficiency_wh_per_mi` is used everywhere the old constant was.
- **Tests:** loader test that switching `?vin=` re-scopes results; a server-fn test asserting a vin-filtered query never returns another vehicle's rows (`user_id` + `vin` both applied). Final `vite build` + `wrangler deploy --dry-run`.
- **Files:** `src/functions/vehicles.functions.ts`, `src/routes/dashboard.tsx`, `src/components/dashboard/DashboardProvider.tsx`, `src/routes/dashboard/{index,charging,drives}.tsx`.

**Dependency graph:** Wave 0 → {1, 2, 3}; Wave 3 → {4, 5}; {4,5} → 6. Waves 1, 2, and the 3→4→5 analytics chain are independent and can proceed in parallel after Wave 0.

---

## 7. Open questions / decisions needed

1. **Cutover/overlap window.** TeslaMate history likely overlaps tesboard's first live poll. Import only rows with `started_at < first_live_poll_at`, or import everything and dedupe on `(vin, started_at)`? The latter risks two near-identical sessions sessionized differently by the two systems at the seam. **Need a cutover policy.**
2. **`preferred_range`.** TeslaMate stores both rated and ideal; tesboard stores one figure. Confirm "rated" (default) — and that the imported `cars.efficiency` was itself derived against the same range basis (mixing rated/ideal corrupts Wh/mi).
3. **Multi-vehicle scope.** Import all cars' history (keyed by vin, scoped by the `?vin=` param) or restrict to one user-chosen VIN?
4. **Volume / Worker limits.** Realistic `positions`+`charges` row counts (years of 2.5 s / 5 s samples = potentially millions)? Determines chunk size, whether to downsample `positions` on import, and Hyperdrive/Supabase write-throughput acceptability. tesboard's `vehicle_snapshot` was sized for `*/2-min` polling — raw `positions` could 100× its row count.
5. **Snapshot semantics clash.** `vehicle_snapshot` is a periodic full-vehicle poll; TeslaMate `positions` and `charges` are two distinct sample streams. Folding both in yields many rows with only-charge or only-GPS fields populated. Acceptable, or should charge samples get a dedicated `charge_sample` table (cleaner, but diverges from the current charge-curve query)?
6. **Supercharger cost authority.** Imported SC costs come from TeslaMate's geofence/manual cost, not the Fleet `/dx` billed record. If tesboard later reconciles the same historical session, which wins? (Proposed precedence: Fleet-billed > imported_teslamate.)
7. **Energy-derivation accuracy.** Imported drive `energy_used_kwh` depends entirely on `cars.efficiency` + reduced-range handling, so it won't match tesboard's measured `wh_per_mi`. Confirm dashboards can mix derived-historical with measured-live without misleading trends.
8. **Geofence adoption.** Should imported geofences actively drive **future** charge classification (changing `reclassifyCharges`), or just label historical rows?
9. **File format/encoding.** Confirm the export is RFC4180 CSV (header row, UTF-8, ISO timestamps) and how NULLs and the `addresses.raw` jsonb are escaped (embedded commas/quotes/newlines). A `\copy` default uses `\N` for NULL — the parser must match the exact COPY/CSV options we instruct.
10. **Auth/identity.** TeslaMate has no `user_id`; we stamp the importing user's uuid on everything. Confirm there is exactly one tesboard user and the imported VIN belongs to them (guard against importing a VIN that doesn't match the linked Tesla account).