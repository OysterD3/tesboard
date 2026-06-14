# tesboard — Read-Only Tesla Dashboard

**Design doc v1 — 2026-06-14**
Stack: TanStack Start (React 19.2, file-router `tsr generate`, Node/Nitro target) · Supabase Postgres (`tesboard`, ref `YOUR_SUPABASE_REF`) · Tesla Fleet API (read-only, **no vehicle commands**).

> Generated from the `tesla-dashboard-research` Ultracode workflow (6 parallel research agents + synthesis), grounded in live Tesla Fleet API docs and the shipped TanStack Intent skills. Verify region via `GET /api/1/users/region` — do not assume NA (Supabase project is in APAC).

---

## 1. The one architectural truth

This is **not an API-proxy dashboard — it's a polling + storage app.** Two hard facts force this:

1. **The Fleet API has NO native trip/drive-history endpoint.** It exposes only current-state snapshots (`vehicle_data`), commands, and telemetry streaming. **Drive records must be constructed** by polling `vehicle_data` over time, persisting snapshots, and sessionizing them.
2. **The Fleet API only returns COST for Tesla-billed sessions** (Superchargers). Home / L2 / third-party AC charging produces **no fee record**. Home-charge cost must be **computed** = `charge_energy_added (kWh) × user electricity rate × loss_factor`.

So the system is: a **sleep-aware background poller** writing raw snapshots to Postgres → a **sessionization engine** segmenting snapshots into drives & charging sessions → a periodic pull of Tesla's Supercharger billing history for authoritative cost. **The UI reads only from Postgres and never wakes the car.**

---

## 2. Verified conclusions (where research agents disagreed)

- **Scope for charging history:** `/dx/charging/history` (the only authoritative Supercharger-cost source) sits behind the misleadingly named **`vehicle_charging_cmds`** scope, which covers *both* reading charging history *and* charge commands. Granting it does **not** force the virtual-key/command path — that's triggered only by actually *sending* signed commands or installing a telemetry config. **Decision (pending user OK):** request `openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds`, send zero commands → functionally read-only, no virtual key. Fallback: drop it and compute *all* costs from `charge_energy_added × rate`.
- **Public key + partner registration are REQUIRED even for read-only.** Hosting the EC public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem` + `POST /api/1/partner_accounts` are prerequisites for *any* Fleet API call (skip → `412 Precondition Failed`). Read-only only lets you skip **in-car virtual-key pairing** and the **Vehicle Command Proxy**.
- **Polling does not drain the battery (modern Tesla firmware).** Normal `vehicle_data` reads don't prevent sleep and don't wake a sleeping car (read on a sleeping car → `408`). Only `wake_up`/commands wake it. Poller must **never call `wake_up`** and must **back off when the car reports `asleep`/`offline`** (check the cheap `GET /api/1/vehicles` `state` first).
- **Polling beats Telemetry for MVP.** Fleet Telemetry needs virtual-key pairing + a self-hosted mTLS server + Kafka. For one personal car, sleep-aware polling needs zero extra infra. Telemetry is a documented later upgrade.
- **Datastore = Supabase Postgres** (`tesboard` already exists; resume it — currently INACTIVE).

---

## 3. Authentication & onboarding

**Two token types:**
- **Partner token** (`grant_type=client_credentials`) — one-time onboarding (register partner account, verify hosted key). Machine-to-machine.
- **Third-party user token** (`grant_type=authorization_code`) — all data reads. Interactive Tesla login (just you).

**Per-user OAuth (TanStack Start server routes):**
- `GET /api/auth/tesla/login` — generate `state` + PKCE verifier/challenge, store in one-shot `__Host-tesla-oauth` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`), `throw redirect()` to `https://auth.tesla.com/oauth2/v3/authorize?...&scope=openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds`.
- `GET /api/auth/tesla/callback` — verify `state`, exchange `code` at `/oauth2/v3/token` → store tokens **server-side in Postgres**, set opaque `__Host-session` cookie, clear oauth cookie, redirect to `/dashboard`. (Server **route**, never a server fn — it's a third-party browser redirect URL.)
- `GET /api/1/users/region` once → persist `fleet_api_base_url` for all later calls.

**Token lifecycle — #1 production gotcha:** access token ~8h. **Tesla rotates the refresh token on every use** — persist the NEW one and discard the old **atomically**, or the chain breaks and forces re-login.

**Cookies:** `__Host-` prefix, `HttpOnly; Secure; SameSite=Lax; Path=/`. Cookie holds an **opaque session id only**; Tesla tokens live server-side keyed by that id. Parse cookies by splitting on the **first** `=`.

---

## 4. Data model (Supabase Postgres)

All tables keyed/partitioned by `vin` so multi-vehicle is a later flip, not a migration.

| Table | Purpose / key columns |
|---|---|
| `tesla_account` | `id`, `user_email`, `fleet_api_base_url`, `created_at` |
| `tesla_token` | `account_id`, `access_token`, `refresh_token`, `access_expires_at`, `scope`, `updated_at` — **server-only, encrypted at rest**, rotated atomically |
| `app_session` | `id` (opaque = cookie value), `account_id`, `expires_at` |
| `vehicle` | `vin` (pk), `tesla_id` (REST id), `vehicle_id` (streaming id — different!), `display_name`, `car_type`, `last_state`, `updated_at` |
| `vehicle_snapshot` | append-only poll rows: `vin`, `recorded_at`, `odometer`, `battery_level`, `usable_battery_level`, `battery_range`, `est_battery_range`, `charge_energy_added`, `charging_state`, `charger_power`, `shift_state`, `latitude`, `longitude`, `speed`, `gps_as_of`, `raw_json` jsonb. Index `(vin, recorded_at)` |
| `charge_session` | `vin`, `source` (`supercharger`/`home`/`other`), `started_at`, `ended_at`, `location_name`, `lat/lng`, `energy_added_kwh`, `miles_added_rated`, `cost_amount`, `cost_currency`, `cost_source` (`tesla_billed`/`computed`), `rate_applied`, `tesla_charge_session_id`, `invoices` jsonb |
| `drive_session` | `vin`, `started_at`, `ended_at`, `start/end_odometer`, `distance_mi`, `duration_s`, `start/end_lat/lng`, `start/end_battery_level`, `energy_used_kwh` (derived), `wh_per_mi` (derived) |
| `electricity_rate` | `account_id`, `kind` (`flat`/`tou`), `currency`, `flat_rate`, `tou_schedule` jsonb, `loss_factor` (~1.1), `effective_from` |
| `tesla_charging_history_import` | backfill bookkeeping: `last_page`, `last_run_at` |

---

## 5. Tesla API surface (read-only)

- `GET /api/1/vehicles` — list; read `state` before polling. Yields `id` (REST), `vehicle_id` (streaming — different), `vin`.
- `GET /api/1/vehicles/{id}/vehicle_data?endpoints=charge_state;drive_state;vehicle_state;gui_settings;location_data` — the snapshot. `200` online, **`408` asleep (does not wake it)**. GPS needs `location_data` group + `vehicle_location` scope.
- `GET /api/1/dx/charging/history?vin=&startTime=&endTime=&pageNo=&pageSize=` — paginated Supercharger/Tesla-billed history. Cost in `fees[]` (`feeType`, `currencyCode`, `usageBase` kWh, `totalDue`). `/dx/charging/sessions` is **business-fleet only — unusable** for a consumer.
- **NOT used:** `wake_up`, any command, `/dx/charging/sessions`, telemetry config.

**Key field mappings:**
- *Distance a charge can drive* → `charge_state.charge_miles_added_rated` (EPA-rated, already a distance). Range fields are **miles regardless of locale**; convert via `gui_settings.gui_distance_units`.
- *Energy for range/home-cost math* → `charge_state.charge_energy_added` (battery side), **not** billed `usageBase` (higher, includes charging losses).
- *Supercharger cost* → sum `fees[].totalDue` (authoritative). *Home cost* → `charge_energy_added × rate × loss_factor` (estimate).

---

## 6. Poller & sessionization (the L-effort core)

Scheduled server-side job:
1. `GET /api/1/vehicles`. If `state != online` → record state, **back off** (no poll, no wake).
2. If `online` → `GET vehicle_data`, append a `vehicle_snapshot`.
3. **Adaptive cadence:** ~5–10 min idle; ~30–60 s while driving (`shift_state != P`) or `charging_state == Charging`; stop when `asleep`/`offline`.
4. **Sessionize:** drive = shift-out-of-Park → N min back in Park; charge = `charging_state` into/out of `Charging`. Compute odometer/battery/energy deltas → write `drive_session` / `charge_session`.
5. **Supercharger reconciliation:** periodic `/dx/charging/history` pull, match billed sessions to `charge_session` rows by time/location → fill authoritative `cost_amount`, `cost_source=tesla_billed`. Home sessions stay `cost_source=computed`.

Cost: ~$0.002/`vehicle_data` request against a ~$10/mo account credit — adaptive polling for one car fits comfortably.

---

## 7. TanStack Start implementation shape

```
src/
  start.ts                              # createStart({ requestMiddleware: [csrfMiddleware] })
  routes/
    api/auth/tesla/login.ts             # server route: PKCE + redirect to Tesla
    api/auth/tesla/callback.ts          # server route: code exchange, set session
    api/cron/poll.ts                    # server route (CRON_TRIGGER_SECRET-guarded): one poll cycle
    dashboard.tsx                       # protected layout (beforeLoad = UX redirect only)
    dashboard/index.tsx                 # overview
    dashboard/charging.tsx              # charging history + per-charge stats
    dashboard/drives.tsx                # drive records
    settings/rate.tsx                   # electricity rate config
  server/
    session.ts                          # cookie helpers (split on first '=')
    auth-middleware.ts                  # session id -> load session -> context
    tesla-client.server.ts              # fetch + bearer + refresh-on-expiry/401 + rotation persist
    tesla-tokens.server.ts              # token persist/read/rotate (Postgres)
    csrf-middleware.ts                  # origin check for non-GET
    db.server.ts                        # Supabase client (service-role, server-only)
  functions/
    charging.functions.ts               # createServerFn GET, reads charge_session
    drives.functions.ts                 # createServerFn GET, reads drive_session
    rate.functions.ts                   # createServerFn POST, writes electricity_rate
```

**Security rules (from the Intent skills):**
- **Every Fleet/DB server fn carries `authMiddleware` on the handler** — route `beforeLoad` guards do NOT protect independently-reachable RPC endpoints.
- Read fns: `createServerFn({ method:'GET' }).middleware([authMiddleware]).validator(zod)`. **Add `zod`** (not yet a dep).
- Shape validation ≠ authorization — scope every query to the session's own `vin`s.
- Response headers: `Cache-Control: private` + `Vary: Cookie`, **never `public`** (CDN cross-user leak).
- Read `process.env.*` **inside** `.server()` handlers, never at module scope. Secrets only in `.server.ts` / server fns. Never `VITE_`-prefix a secret.

---

## 8. Environment variables (all server-only, no `VITE_`)

| Var | Purpose |
|---|---|
| `TESLA_CLIENT_ID` | Fleet API app client id (authorize + token + partner-token) |
| `TESLA_CLIENT_SECRET` | Client secret (authorization_code + client_credentials). **Rotate — was pasted in chat.** |
| `TESLA_REDIRECT_URI` | Registered OAuth redirect, `https://<domain>/api/auth/tesla/callback` |
| `TESLA_APP_DOMAIN` | Root domain hosting `.well-known` key + registered via `partner_accounts` |
| `TESLA_FLEET_BASE_URL` | Regional base URL (seed, then override via `GET /users/region`) |
| `TESLA_PRIVATE_KEY_PEM` | secp256r1 EC **private** key (public half is hosted) |
| `SESSION_SECRET` | Signs/derives the opaque app session id |
| `APP_ORIGIN` | Canonical origin for CSRF/origin check |
| `SUPABASE_URL` | Supabase project URL (`tesboard`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side DB key (bypasses RLS; `.server.ts` only) |
| `CRON_TRIGGER_SECRET` | Guards `/api/cron/poll` so only the scheduler triggers it |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Tesla tokens at rest in Postgres |

---

## 9. Setup steps (manual — user must do these)

1. **Resume** the Supabase project `tesboard` (ref `YOUR_SUPABASE_REF`) — currently INACTIVE — and grab `SUPABASE_URL` + service-role key.
2. **Register a Tesla Fleet app** at developer.tesla.com: scopes `openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds`; Allowed Origin = your root HTTPS domain; Allowed Redirect URI = `https://<domain>/api/auth/tesla/callback`. Copy Client ID + Secret.
3. **Provision a public HTTPS domain** (required for the public key, the OAuth redirect, and `__Host-`/`Secure` cookies).
4. **Generate a secp256r1 EC keypair.** Host the **public** PEM at `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`. Keep the private key in `TESLA_PRIVATE_KEY_PEM`.
5. **Register the partner account:** partner token (`client_credentials`) → `POST /api/1/partner_accounts {domain}` → verify `GET /api/1/partner_accounts/public_key?domain=<domain>`.
6. **Populate `.env`** (gitignored) with all server-only vars; confirm none carry `VITE_`.
7. **Run the DB migration** to create the tables in §4.
8. **Complete the OAuth login once** (`/api/auth/tesla/login`); verify `GET /api/1/users/region` returns your `fleet_api_base_url`.
9. **Enter your home electricity rate** (flat or TOU) + loss factor (~1.1) before expecting accurate home-charge cost.
10. **Configure the scheduler** (Supabase `pg_cron` + edge function, or external cron) to call the guarded `/api/cron/poll` on the adaptive cadence.

---

## 10. Feature roadmap

**MVP (the asks):** Charging History (M) · Per-Charge Stats = cost + drivable range (M) · Drive Records (L) · Electricity Rate Config (S, prerequisite for home cost).

**Phase 2 (cheap once ingestion exists):** Charging Cost Analytics (home vs SC, $/mi, monthly) · Efficiency Wh/mi vs EPA · Range vs Actual · Idle/Vampire-Drain Tracking · Drive & Charging Maps · Battery-Degradation Estimate · Data Export.

**Later:** Monthly/PDF Reports · Advisory Alerts (notify-only) · TOU Cost-Saving Insights · Multi-Vehicle · Fleet Telemetry migration.

**Out of scope (require commands):** start/stop/scheduled charging, set charge limit, preconditioning, lock/flash/sentry.

---

## 11. Risks & gotchas

1. **Refresh-token rotation must be atomic** — Tesla invalidates the old refresh token on every refresh; stale reuse breaks the chain and forces re-login.
2. **Home cost is computed, not billed** — accuracy bounded by the user's rate input; underestimates without a loss factor.
3. `/dx/charging/sessions` is business-fleet only — use `/history`; cost only for Supercharger/Tesla-billed sessions.
4. **No native trips** — drive records exist only if the poller runs reliably; scheduler gaps = history gaps. Riskiest MVP item; ships once snapshots accrue.
5. **Poll cadence vs fidelity vs cost** — must be adaptive + sleep-aware.
6. **Never call `wake_up`/commands** — would wake the car & cause vampire drain. `vehicle_data` on a sleeping car returns `408` and does NOT wake it.
7. **Partner registration + hosted key mandatory** even read-only (skip → `412`). `412` also signals wrong region — confirm via `GET /users/region`.
8. **Use `charge_energy_added`, not billed `usageBase`**, for range/efficiency math (billed kWh includes losses).
9. **Keep authoritative (SC-billed) vs computed (home) cost visually distinct** via `cost_source`.
10. **GPS is privacy-sensitive** — personal use; encrypt tokens at rest.
11. **Tesla data retention undocumented** — persist everything ourselves; backfill from account start.
12. **TanStack security boundaries** — server fns are independently-reachable RPCs (auth on every handler); never `Cache-Control: public` on identity-dependent responses; secrets only inside handlers.
13. **Telemetry later = infra jump** — virtual-key + signed config + mTLS server + Kafka.

---

## 12. Open decisions (see chat)

1. Datastore: plain server-side Postgres vs Supabase Auth+RLS → **rec: plain Postgres via service-role, `.server.ts`-only.**
2. Scope: request `vehicle_charging_cmds` (authoritative SC cost, still send no commands) vs drop it (compute all costs) → **rec: request it.**
3. Electricity rate model: flat + loss factor now (TOU stubbed) vs full TOU now → **rec: flat + loss, TOU schema stubbed.**
4. Polling cadence/scheduler → **rec: adaptive cadence via Supabase pg_cron or external cron hitting guarded route.**
5. Deployment domain / HTTPS → **rec: pick a stable HTTPS subdomain early; pin it as Tesla Allowed Origin + redirect.**
6. Token-at-rest protection → **rec: app-layer AES via `TOKEN_ENCRYPTION_KEY`.**

---

## 13. Cloudflare Workers deployment (chosen target)

Decided 2026-06-14. The app deploys to **Cloudflare Workers** via `@cloudflare/vite-plugin`.

- **vite.config.ts:** `cloudflare({ viteEnvironment: { name: 'ssr' } })` runs the server in workerd for dev + build.
- **wrangler.jsonc:** `compatibility_flags: ["nodejs_compat"]` (enables `node:crypto` — AES-GCM/PKCE/`timingSafeEqual` — and per-request `process.env`), `main: src/worker.ts`, `triggers.crons: ["*/2 * * * *", "0 * * * *"]`, plus non-secret `vars`.
- **src/worker.ts:** wraps `@tanstack/react-start/server-entry` `fetch` and adds `scheduled()` so the **poller runs on native Cron Triggers** — no external scheduler. `*/2` → `runPollCycle()`, hourly → `reconcileAllUsers()` (by `event.cron`). It bridges Worker bindings into `process.env` because the scheduled (non-request) context doesn't auto-populate it.
- **Static key:** `public/.well-known/appspecific/com.tesla.3p.public-key.pem` is served by Workers Assets at the Tesla-required URL once the custom domain is live.
- **Env model:** server vars/secrets → `process.env` in the Worker (`.dev.vars` for dev, wrangler `vars`/`wrangler secret put` for prod). `VITE_*` → build-time, baked into the client from `.env`.
- **Secrets** (`wrangler secret put`): `TESLA_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_TRIGGER_SECRET`, `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, optional `TESLA_PRIVATE_KEY_PEM`.
- **Commands:** `pnpm build` → `pnpm deploy` (`vite build && wrangler deploy`). Validated locally with `wrangler deploy --dry-run`.
- **Cadence/cost:** Cloudflare cron minimum is 1 minute; `*/2` balances drive granularity against the ~$10/mo Fleet API credit. Raise/lower in `wrangler.jsonc`.
- **Status:** build + typecheck + dry-run all green. Not yet deployed (needs the user's Cloudflare account + custom domain).
