/**
 * One-way migration: TeslaMate Postgres → tesboard (Supabase) Postgres.
 *
 * Reads the user's self-hosted TeslaMate database directly and writes the
 * mapped/converted rows into tesboard via the DIRECT (session, :5432) connection
 * — the same one drizzle-kit migrations use, NOT Hyperdrive/6543. Runs as a
 * single bare-node process, so old→new id maps are held in memory (the
 * import_pk_map table exists for a future resumable Worker-upload path).
 *
 * Usage:
 *   TESLAMATE_DATABASE_URL=postgres://teslamate:password@localhost:5432/teslamate \
 *   node scripts/import-teslamate.mjs <tesboard-user-email> [options]
 *   pnpm import:teslamate <email> [options]
 *
 * Options:
 *   --positions-interval=<sec>   downsample positions to >= 1 row / N s (default 60)
 *   --charges-interval=<sec>     downsample charge samples to >= 1 row / N s (default 30)
 *   --no-samples                 skip positions + charges (drives/charges summaries only)
 *   --dry-run                    read + map everything, print counts, write nothing
 *
 * Idempotent: re-running upserts on the business keys (vin+started_at for
 * sessions, vin+stream+source_pk for samples), so a second run inserts ~0 rows.
 *
 * Everything in TeslaMate is metric; tesboard stores miles + °C. All conversions
 * live in ./teslamate/convert.mjs (unit-tested).
 */
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import {
  chargeLocationType,
  driveEnergyKwh,
  efficiencyKwhPerKmToWhPerMi,
  isDcFastCharge,
  kmToMi,
  kmhToMph,
  mapBillingType,
  mapChargeCost,
  minutesToSeconds,
  whPerMi,
} from './teslamate/convert.mjs'

// ── env + args ───────────────────────────────────────────────────────────────
function loadFromFile(path, key) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* file may not exist */
  }
  return undefined
}
const resolve = (key) =>
  process.env[key] || loadFromFile('.dev.vars', key) || loadFromFile('.env', key) || ''

const argv = process.argv.slice(2)
const email = argv.find((a) => !a.startsWith('--'))
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}
const flag = (name) => argv.includes(`--${name}`)

if (!email) {
  console.error('Usage: node scripts/import-teslamate.mjs <tesboard-user-email> [options]')
  process.exit(1)
}

const TM_URL = resolve('TESLAMATE_DATABASE_URL')
const TB_URL = resolve('DIRECT_URL') || resolve('DATABASE_URL')
if (!TM_URL) {
  console.error('Missing TESLAMATE_DATABASE_URL (checked env, .dev.vars, .env).')
  process.exit(1)
}
if (!TB_URL) {
  console.error('Missing DIRECT_URL / DATABASE_URL for tesboard (use the :5432 session URL).')
  process.exit(1)
}

const POS_INTERVAL = Number(opt('positions-interval', '60'))
const CHG_INTERVAL = Number(opt('charges-interval', '30'))
const NO_SAMPLES = flag('no-samples')
const DRY = flag('dry-run')

// TeslaMate timestamps are `timestamp without time zone`, stored in UTC. Format
// them verbatim and append Z — no timezone conversion (which would depend on the
// session TimeZone and silently shift everything).
const ISO = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

const tm = postgres(TM_URL, { max: 3, idle_timeout: 20 })
const tb = postgres(TB_URL, { max: 3, prepare: false, idle_timeout: 20 })

const counts = {}
const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n)
const log = (...a) => console.log(...a)

// ── main ─────────────────────────────────────────────────────────────────────
let batchId = null
try {
  const [user] = await tb`select id from auth.users where email = ${email} limit 1`
  if (!user) throw new Error(`No tesboard user with email ${email}. Run pnpm user:create first.`)
  const userId = user.id
  log(`→ tesboard user ${email} = ${userId}`)

  const settings = (await tm`select preferred_range from settings limit 1`)[0] ?? {}
  const preferred = settings.preferred_range === 'ideal' ? 'ideal' : 'rated'
  log(`→ TeslaMate preferred_range = ${preferred}`)

  // Cutover reference: earliest live snapshot already in tesboard for this user.
  // (recorded_at is timestamptz here; postgres-js returns a Date → ISO via JS.)
  // Best-effort: if the 0003 schema isn't applied yet (no import_source column),
  // skip it — a --dry-run must work pre-migration, and the real run will fail
  // later with a clearer message when it tries to write the new columns.
  let cutover = null
  try {
    const [{ cutover_raw } = {}] =
      await tb`select min(recorded_at) as cutover_raw from vehicle_snapshot where user_id = ${userId} and import_source = 'live'`
    cutover = cutover_raw ? new Date(cutover_raw).toISOString() : null
  } catch (e) {
    if (/import_source|does not exist/i.test(e.message)) {
      console.warn('⚠ tesboard schema 0003 not applied yet (run `pnpm db:migrate`).')
      if (!DRY) throw new Error('Apply migration 0003 first: pnpm db:migrate (needs DIRECT_URL).')
    } else throw e
  }

  if (!DRY) {
    const [b] = await tb`
      insert into import_batch (user_id, source, status, preferred_range, cutover_at)
      values (${userId}, 'teslamate', 'running', ${preferred}, ${cutover ?? null})
      returning id`
    batchId = b.id
    log(`→ import_batch #${batchId} (cutover ${cutover ?? 'none'})`)
  }

  // 1. cars → vehicle (matched/created by VIN) ────────────────────────────────
  const carMap = new Map() // tm cars.id → tesboard vin
  const carEff = new Map() // vin → efficiency (kWh/km) for drive-energy derivation
  const carFreeSc = new Map() // vin → free_supercharging
  const cars = await tm`
    select c.id, c.vin, c.name, c.model, c.trim_badging, c.marketing_name, c.exterior_color,
           c.wheel_type, c.spoiler_type, c.efficiency, c.eid, c.vid,
           cs.free_supercharging, cs.lfp_battery
    from cars c left join car_settings cs on cs.id = c.settings_id`
  for (const c of cars) {
    if (!c.vin) continue
    carMap.set(c.id, c.vin)
    carEff.set(c.vin, c.efficiency != null ? Number(c.efficiency) : null)
    carFreeSc.set(c.vin, !!c.free_supercharging)
    if (DRY) {
      bump('vehicles')
      continue
    }
    const effWhMi = efficiencyKwhPerKmToWhPerMi(c.efficiency != null ? Number(c.efficiency) : null)
    const [existing] =
      await tb`select vin from vehicle where vin = ${c.vin} and user_id = ${userId}`
    if (existing) {
      await tb`
        update vehicle set
          model = coalesce(${c.model ?? null}, model),
          trim_badging = coalesce(${c.trim_badging ?? null}, trim_badging),
          marketing_name = coalesce(${c.marketing_name ?? null}, marketing_name),
          exterior_color = coalesce(${c.exterior_color ?? null}, exterior_color),
          wheel_type = coalesce(${c.wheel_type ?? null}, wheel_type),
          spoiler_type = coalesce(${c.spoiler_type ?? null}, spoiler_type),
          efficiency_wh_per_mi = coalesce(${effWhMi}, efficiency_wh_per_mi),
          is_lfp = ${!!c.lfp_battery},
          free_supercharging = ${!!c.free_supercharging},
          updated_at = now()
        where vin = ${c.vin} and user_id = ${userId}`
    } else {
      await tb`
        insert into vehicle (vin, user_id, tesla_id, vehicle_id, display_name, model, trim_badging,
          marketing_name, exterior_color, wheel_type, spoiler_type, efficiency_wh_per_mi, is_lfp,
          free_supercharging)
        values (${c.vin}, ${userId}, ${String(c.eid ?? c.vid ?? c.vin)}, ${c.vid ? String(c.vid) : null},
          ${c.name ?? null}, ${c.model ?? null}, ${c.trim_badging ?? null}, ${c.marketing_name ?? null},
          ${c.exterior_color ?? null}, ${c.wheel_type ?? null}, ${c.spoiler_type ?? null}, ${effWhMi},
          ${!!c.lfp_battery}, ${!!c.free_supercharging})`
    }
    bump('vehicles')
  }
  log(`✓ vehicles: ${counts.vehicles ?? 0}`)

  // 2. geofences → geofence ───────────────────────────────────────────────────
  const geoMap = new Map() // tm geofences.id → tesboard geofence.id
  const geofences = await tm`
    select id, name, latitude, longitude, radius, cost_per_unit, session_fee, billing_type
    from geofences`
  for (const g of geofences) {
    if (DRY) {
      bump('geofences')
      continue
    }
    const [row] = await tb`
      insert into geofence (user_id, name, lat, lng, radius_m, billing_type, cost_per_unit,
        session_fee, source_pk)
      values (${userId}, ${g.name}, ${g.latitude ?? null}, ${g.longitude ?? null},
        ${g.radius ?? 150}, ${mapBillingType(g.billing_type)}, ${g.cost_per_unit ?? null},
        ${g.session_fee ?? null}, ${g.id})
      on conflict (user_id, lower(name)) do update set
        lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
        billing_type = excluded.billing_type, cost_per_unit = excluded.cost_per_unit,
        session_fee = excluded.session_fee, source_pk = excluded.source_pk, updated_at = now()
      returning id`
    geoMap.set(g.id, row.id)
    bump('geofences')
  }
  log(`✓ geofences: ${counts.geofences ?? 0}`)

  // 3. addresses → address ────────────────────────────────────────────────────
  const addrMap = new Map() // tm addresses.id → tesboard address.id
  const addresses = await tm`
    select id, osm_id, osm_type, display_name, name, house_number, road, neighbourhood, city,
           county, postcode, state, state_district, country, latitude, longitude, raw
    from addresses`
  for (const a of addresses) {
    if (DRY) {
      bump('addresses')
      continue
    }
    // TeslaMate addresses have no geofence link (geofence_id lives on the fact rows).
    const gid = null
    let row
    if (a.osm_id != null) {
      ;[row] = await tb`
        insert into address (user_id, osm_id, osm_type, display_name, name, house_number, road,
          neighbourhood, city, county, postcode, state, state_district, country, lat, lng, raw_json,
          geofence_id, source_pk)
        values (${userId}, ${a.osm_id}, ${a.osm_type ?? null}, ${a.display_name ?? null},
          ${a.name ?? null}, ${a.house_number ?? null}, ${a.road ?? null}, ${a.neighbourhood ?? null},
          ${a.city ?? null}, ${a.county ?? null}, ${a.postcode ?? null}, ${a.state ?? null},
          ${a.state_district ?? null}, ${a.country ?? null}, ${a.latitude ?? null}, ${a.longitude ?? null},
          ${a.raw ? tb.json(a.raw) : null}, ${gid}, ${a.id})
        on conflict (user_id, osm_id, osm_type) where osm_id is not null do update set
          display_name = excluded.display_name, geofence_id = excluded.geofence_id,
          source_pk = excluded.source_pk
        returning id`
    } else {
      ;[row] = await tb`
        insert into address (user_id, display_name, name, lat, lng, raw_json, geofence_id, source_pk)
        values (${userId}, ${a.display_name ?? null}, ${a.name ?? null}, ${a.latitude ?? null},
          ${a.longitude ?? null}, ${a.raw ? tb.json(a.raw) : null}, ${gid}, ${a.id})
        returning id`
    }
    addrMap.set(a.id, row.id)
    bump('addresses')
  }
  log(`✓ addresses: ${counts.addresses ?? 0}`)

  // 4. charging_processes → charge_session ────────────────────────────────────
  const chargeMap = new Map() // tm charging_processes.id → tesboard charge_session.id
  const chargeVin = new Map() // tesboard charge_session.id → vin (for charge samples)
  const cps = await tm`
    select cp.id, cp.car_id, ${tm.unsafe(ISO('cp.start_date'))} as started_at,
      ${tm.unsafe(ISO('cp.end_date'))} as ended_at, cp.charge_energy_added, cp.charge_energy_used,
      cp.start_battery_level, cp.end_battery_level, cp.duration_min, cp.outside_temp_avg, cp.cost,
      cp.start_rated_range_km, cp.end_rated_range_km, cp.start_ideal_range_km, cp.end_ideal_range_km,
      cp.geofence_id, cp.address_id, p.latitude as pos_lat, p.longitude as pos_lng,
      fc.fast_charger_type, fc.fast_charger_brand
    from charging_processes cp
    left join positions p on p.id = cp.position_id
    left join lateral (
      select fast_charger_type, fast_charger_brand from charges ch
      where ch.charging_process_id = cp.id and ch.fast_charger_type is not null limit 1
    ) fc on true
    order by cp.start_date asc`
  for (const cp of cps) {
    const vin = carMap.get(cp.car_id)
    if (!vin || !cp.started_at) continue
    const startR = preferred === 'ideal' ? cp.start_ideal_range_km : cp.start_rated_range_km
    const endR = preferred === 'ideal' ? cp.end_ideal_range_km : cp.end_rated_range_km
    const milesAdded =
      startR != null && endR != null ? kmToMi(Number(endR) - Number(startR)) : null
    const dc = isDcFastCharge(cp.fast_charger_type, cp.fast_charger_brand)
    const { source, cost_source, cost_amount } = mapChargeCost({
      fastChargerType: cp.fast_charger_type,
      fastChargerBrand: cp.fast_charger_brand,
      freeSupercharging: carFreeSc.get(vin),
      tmCost: cp.cost,
    })
    const gid = cp.geofence_id != null ? (geoMap.get(cp.geofence_id) ?? null) : null
    const locType = chargeLocationType({ isDc: dc, hasGeofence: gid != null, geofenceIsHome: false })
    if (DRY) {
      bump('charges')
      continue
    }
    const [row] = await tb`
      insert into charge_session (vin, user_id, source, started_at, ended_at, lat, lng,
        energy_added_kwh, energy_used_kwh, miles_added_rated, start_range_mi, end_range_mi,
        start_battery_level, end_battery_level, outside_temp_avg, fast_charger_type,
        charge_location_type, geofence_id, address_id, cost_amount, cost_source, import_source, source_pk)
      values (${vin}, ${userId}, ${source}, ${cp.started_at}, ${cp.ended_at ?? null},
        ${cp.pos_lat ?? null}, ${cp.pos_lng ?? null}, ${cp.charge_energy_added ?? null},
        ${cp.charge_energy_used ?? null}, ${milesAdded}, ${kmToMi(startR != null ? Number(startR) : null)},
        ${kmToMi(endR != null ? Number(endR) : null)}, ${cp.start_battery_level ?? null},
        ${cp.end_battery_level ?? null}, ${cp.outside_temp_avg ?? null}, ${cp.fast_charger_type ?? null},
        ${locType}, ${gid}, ${cp.address_id != null ? (addrMap.get(cp.address_id) ?? null) : null},
        ${cost_amount}, ${cost_source}, 'teslamate', ${cp.id})
      on conflict (vin, started_at) where import_source <> 'live' do update set
        ended_at = excluded.ended_at, energy_added_kwh = excluded.energy_added_kwh,
        cost_amount = excluded.cost_amount, cost_source = excluded.cost_source,
        source_pk = excluded.source_pk, updated_at = now()
      returning id`
    chargeMap.set(cp.id, row.id)
    chargeVin.set(row.id, vin)
    bump('charges')
  }
  log(`✓ charge sessions: ${counts.charges ?? 0}`)

  // 5. drives → drive_session ─────────────────────────────────────────────────
  const driveMap = new Map() // tm drives.id → tesboard drive_session.id
  const endpointPosIds = new Set() // positions we MUST keep (drive endpoints)
  const drives = await tm`
    select d.id, d.car_id, ${tm.unsafe(ISO('d.start_date'))} as started_at,
      ${tm.unsafe(ISO('d.end_date'))} as ended_at, d.start_km, d.end_km, d.distance, d.duration_min,
      d.speed_max, d.power_max, d.power_min, d.outside_temp_avg, d.inside_temp_avg,
      d.start_rated_range_km, d.end_rated_range_km, d.start_ideal_range_km, d.end_ideal_range_km,
      d.ascent, d.descent, d.start_position_id, d.end_position_id,
      d.start_address_id, d.end_address_id, d.start_geofence_id, d.end_geofence_id,
      sp.latitude as s_lat, sp.longitude as s_lng, sp.battery_level as s_bl,
      ep.latitude as e_lat, ep.longitude as e_lng, ep.battery_level as e_bl,
      c.efficiency
    from drives d
    join cars c on c.id = d.car_id
    left join positions sp on sp.id = d.start_position_id
    left join positions ep on ep.id = d.end_position_id
    order by d.start_date asc`
  for (const d of drives) {
    const vin = carMap.get(d.car_id)
    if (!vin || !d.started_at) continue
    if (d.start_position_id != null) endpointPosIds.add(d.start_position_id)
    if (d.end_position_id != null) endpointPosIds.add(d.end_position_id)
    const distanceMi = kmToMi(d.distance != null ? Number(d.distance) : null)
    const startR = preferred === 'ideal' ? d.start_ideal_range_km : d.start_rated_range_km
    const endR = preferred === 'ideal' ? d.end_ideal_range_km : d.end_rated_range_km
    const eff = d.efficiency != null ? Number(d.efficiency) : null
    const energy = driveEnergyKwh(
      startR != null ? Number(startR) : null,
      endR != null ? Number(endR) : null,
      eff,
    )
    if (DRY) {
      bump('drives')
      continue
    }
    const [row] = await tb`
      insert into drive_session (vin, user_id, started_at, ended_at, start_odometer, end_odometer,
        distance_mi, duration_s, start_lat, start_lng, end_lat, end_lng, start_battery_level,
        end_battery_level, start_range_mi, end_range_mi, energy_used_kwh, wh_per_mi, outside_temp_avg,
        inside_temp_avg, speed_max_mph, power_max_kw, power_min_kw, ascent, descent, start_geofence_id,
        end_geofence_id, start_address_id, end_address_id, import_source, source_pk)
      values (${vin}, ${userId}, ${d.started_at}, ${d.ended_at ?? null},
        ${kmToMi(d.start_km != null ? Number(d.start_km) : null)},
        ${kmToMi(d.end_km != null ? Number(d.end_km) : null)}, ${distanceMi},
        ${minutesToSeconds(d.duration_min != null ? Number(d.duration_min) : null)},
        ${d.s_lat ?? null}, ${d.s_lng ?? null}, ${d.e_lat ?? null}, ${d.e_lng ?? null},
        ${d.s_bl ?? null}, ${d.e_bl ?? null},
        ${kmToMi(startR != null ? Number(startR) : null)}, ${kmToMi(endR != null ? Number(endR) : null)},
        ${energy}, ${whPerMi(energy, distanceMi)}, ${d.outside_temp_avg ?? null},
        ${d.inside_temp_avg ?? null}, ${d.speed_max != null ? Math.round(kmhToMph(Number(d.speed_max))) : null},
        ${d.power_max ?? null}, ${d.power_min ?? null}, ${d.ascent ?? null}, ${d.descent ?? null},
        ${d.start_geofence_id != null ? (geoMap.get(d.start_geofence_id) ?? null) : null},
        ${d.end_geofence_id != null ? (geoMap.get(d.end_geofence_id) ?? null) : null},
        ${d.start_address_id != null ? (addrMap.get(d.start_address_id) ?? null) : null},
        ${d.end_address_id != null ? (addrMap.get(d.end_address_id) ?? null) : null},
        'teslamate', ${d.id})
      on conflict (vin, started_at) where import_source <> 'live' do update set
        ended_at = excluded.ended_at, distance_mi = excluded.distance_mi,
        energy_used_kwh = excluded.energy_used_kwh, wh_per_mi = excluded.wh_per_mi,
        source_pk = excluded.source_pk
      returning id`
    driveMap.set(d.id, row.id)
    bump('drives')
  }
  log(`✓ drive sessions: ${counts.drives ?? 0}`)

  // 6. positions → vehicle_snapshot (downsampled GPS/telemetry stream) ─────────
  if (!NO_SAMPLES) {
    await streamSamples({
      label: 'positions',
      countKey: 'position_samples',
      interval: POS_INTERVAL,
      forceKeepIds: endpointPosIds,
      readPage: (lastId, limit) => tm`
        select id, car_id, ${tm.unsafe(ISO('date'))} as recorded_at, latitude, longitude, speed, power,
          odometer, battery_level, usable_battery_level, rated_battery_range_km, ideal_battery_range_km,
          est_battery_range_km, outside_temp, inside_temp, elevation, drive_id
        from positions where id > ${lastId} order by id asc limit ${limit}`,
      mapRow: (p) => ({
        vin: carMap.get(p.car_id) ?? null,
        user_id: userId,
        recorded_at: p.recorded_at,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        speed: p.speed != null ? kmhToMph(Number(p.speed)) : null,
        power_kw: p.power ?? null,
        odometer: kmToMi(p.odometer != null ? Number(p.odometer) : null),
        battery_level: p.battery_level ?? null,
        usable_battery_level: p.usable_battery_level ?? null,
        battery_range:
          kmToMi(
            (preferred === 'ideal' ? p.ideal_battery_range_km : p.rated_battery_range_km) != null
              ? Number(preferred === 'ideal' ? p.ideal_battery_range_km : p.rated_battery_range_km)
              : null,
          ) ?? null,
        est_battery_range: kmToMi(p.est_battery_range_km != null ? Number(p.est_battery_range_km) : null),
        outside_temp: p.outside_temp ?? null,
        inside_temp: p.inside_temp ?? null,
        elevation_m: p.elevation ?? null,
        source_drive_id: p.drive_id != null ? (driveMap.get(p.drive_id) ?? null) : null,
        import_source: 'teslamate_position',
        source_pk: p.id,
      }),
      // positions has no car_id column directly? it does (car_id). add to read.
    })
    // backfill drive endpoint snapshot links
    if (!DRY && endpointPosIds.size) {
      const ids = [...endpointPosIds]
      const snaps = await tb`
        select id, source_pk from vehicle_snapshot
        where user_id = ${userId} and import_source = 'teslamate_position'
          and source_pk = any(${ids})`
      const snapByPos = new Map(snaps.map((s) => [Number(s.source_pk), s.id]))
      for (const d of drives) {
        const did = driveMap.get(d.id)
        if (!did) continue
        const s = d.start_position_id != null ? snapByPos.get(d.start_position_id) : null
        const e = d.end_position_id != null ? snapByPos.get(d.end_position_id) : null
        if (s || e)
          await tb`update drive_session set start_snapshot_id = ${s ?? null},
            end_snapshot_id = ${e ?? null} where id = ${did}`
      }
      log(`✓ linked drive endpoints`)
    }

    // 7. charges → vehicle_snapshot (downsampled charge-curve stream) ──────────
    await streamSamples({
      label: 'charges',
      countKey: 'charge_samples',
      interval: CHG_INTERVAL,
      forceKeepIds: new Set(),
      readPage: (lastId, limit) => tm`
        select id, charging_process_id, ${tm.unsafe(ISO('date'))} as recorded_at, battery_level,
          usable_battery_level, charge_energy_added, charger_power, charger_voltage,
          charger_actual_current, charger_phases, rated_battery_range_km, ideal_battery_range_km,
          outside_temp
        from charges where id > ${lastId} order by id asc limit ${limit}`,
      mapRow: (ch) => {
        const cid = ch.charging_process_id != null ? chargeMap.get(ch.charging_process_id) : null
        const vin = cid ? chargeVin.get(cid) : null
        return {
          vin: vin ?? null,
          user_id: userId,
          recorded_at: ch.recorded_at,
          battery_level: ch.battery_level ?? null,
          usable_battery_level: ch.usable_battery_level ?? null,
          charge_energy_added: ch.charge_energy_added ?? null,
          charging_state: 'Charging',
          charger_power: ch.charger_power ?? null,
          charger_voltage: ch.charger_voltage ?? null,
          charger_actual_current: ch.charger_actual_current ?? null,
          charger_phases: ch.charger_phases ?? null,
          battery_range: kmToMi(
            (preferred === 'ideal' ? ch.ideal_battery_range_km : ch.rated_battery_range_km) != null
              ? Number(preferred === 'ideal' ? ch.ideal_battery_range_km : ch.rated_battery_range_km)
              : null,
          ),
          outside_temp: ch.outside_temp ?? null,
          source_charge_id: cid ?? null,
          import_source: 'teslamate_charge',
          source_pk: ch.id,
        }
      },
    })
  }

  // 8. states → vehicle_state ─────────────────────────────────────────────────
  await importIntervals({
    label: 'states',
    countKey: 'states',
    rows: await tm`select id, car_id, state, ${tm.unsafe(ISO('start_date'))} as started_at,
      ${tm.unsafe(ISO('end_date'))} as ended_at from states order by start_date asc`,
    insert: async (s) => {
      const vin = carMap.get(s.car_id)
      if (!vin || !s.started_at) return false
      await tb`
        insert into vehicle_state (vin, user_id, state, started_at, ended_at, import_source, source_pk)
        values (${vin}, ${userId}, ${normalizeState(s.state)}, ${s.started_at}, ${s.ended_at ?? null},
          'teslamate', ${s.id})
        on conflict (vin, started_at) do update set ended_at = excluded.ended_at,
          state = excluded.state, source_pk = excluded.source_pk`
      return true
    },
  })

  // 9. updates → software_update ──────────────────────────────────────────────
  await importIntervals({
    label: 'updates',
    countKey: 'updates',
    rows: await tm`select id, car_id, version, ${tm.unsafe(ISO('start_date'))} as started_at,
      ${tm.unsafe(ISO('end_date'))} as ended_at from updates order by start_date asc`,
    insert: async (u) => {
      const vin = carMap.get(u.car_id)
      if (!vin || !u.started_at) return false
      await tb`
        insert into software_update (vin, user_id, version, started_at, ended_at, import_source, source_pk)
        values (${vin}, ${userId}, ${u.version ?? null}, ${u.started_at}, ${u.ended_at ?? null},
          'teslamate', ${u.id})
        on conflict (vin, started_at, version) do update set ended_at = excluded.ended_at,
          source_pk = excluded.source_pk`
      return true
    },
  })

  if (!DRY) {
    await tb`update import_batch set status = 'completed', row_counts = ${tb.json(counts)},
      finished_at = now() where id = ${batchId}`
  }
  log('\n── summary ──')
  for (const [k, v] of Object.entries(counts)) log(`  ${k}: ${v}`)
  log(DRY ? '\n(dry run — nothing written)' : `\n✓ import complete (batch #${batchId})`)
} catch (e) {
  console.error('\n✗ import failed:', e.message)
  if (batchId && !DRY) {
    try {
      await tb`update import_batch set status = 'failed', error = ${String(e.message)},
        finished_at = now() where id = ${batchId}`
    } catch {
      /* best effort */
    }
  }
  process.exitCode = 1
} finally {
  await tm.end({ timeout: 5 })
  await tb.end({ timeout: 5 })
}

// ── helpers ────────────────────────────────────────────────────────────────
function normalizeState(s) {
  if (s == null) return 'unknown'
  if (typeof s === 'string') return s
  // TeslaMate stores states.state as an Ecto.Enum; common ordering:
  const byIndex = ['online', 'offline', 'asleep', 'driving', 'charging', 'updating', 'start']
  return byIndex[Number(s)] ?? String(s)
}

async function importIntervals({ label, countKey, rows, insert }) {
  for (const r of rows) {
    if (DRY) {
      bump(countKey)
      continue
    }
    if (await insert(r)) bump(countKey)
  }
  log(`✓ ${label}: ${counts[countKey] ?? 0}`)
}

/**
 * Stream a huge sample table (positions / charges) by id pages, downsample each
 * page by time interval (carrying lastKept across pages), and bulk-insert the
 * kept rows. forceKeepIds are always retained (drive endpoints).
 */
async function streamSamples({ label, countKey, interval, forceKeepIds, readPage, mapRow }) {
  const PAGE = 5000
  const INSERT_CHUNK = 500
  let lastId = 0
  let lastKeptMs = -Infinity
  let scanned = 0
  for (;;) {
    const page = await readPage(lastId, PAGE)
    if (!page.length) break
    lastId = page[page.length - 1].id
    scanned += page.length
    const keep = []
    for (let i = 0; i < page.length; i++) {
      const r = page[i]
      const t = new Date(r.recorded_at ?? r.date).getTime()
      const forced = forceKeepIds.has(r.id) || (interval <= 0)
      if (forced || t - lastKeptMs >= interval * 1000) {
        keep.push(r)
        if (!forced || interval > 0) lastKeptMs = t
      }
    }
    if (DRY) {
      bump(countKey, keep.length)
      if (page.length < PAGE) break
      continue
    }
    const mapped = keep.map(mapRow).filter((m) => m.vin)
    for (let i = 0; i < mapped.length; i += INSERT_CHUNK) {
      const chunk = mapped.slice(i, i + INSERT_CHUNK)
      await tb`insert into vehicle_snapshot ${tb(chunk)}
        on conflict (vin, import_source, source_pk) where source_pk is not null do nothing`
      bump(countKey, chunk.length)
    }
    if (page.length < PAGE) break
  }
  log(`✓ ${label}: kept ${counts[countKey] ?? 0} / scanned ${scanned}`)
}
