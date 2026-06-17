/**
 * One-way import: a Tessie CSV export → tesboard (Supabase) Postgres.
 *
 * Tessie exports a folder named after the VIN containing one CSV per telemetry
 * stream (battery / charging / climate / vehicle / driving, plus per-wheel TPMS).
 * Unlike TeslaMate there are NO pre-computed drive/charge summaries — only raw
 * per-sample streams — so this importer SESSIONIZES them exactly the way the live
 * poller (src/server/poller.ts) does: a drive = a run of Shift State ∈ {D,R,N};
 * a charge = a run of Charging State === 'Charging'. The pure parsing /
 * sessionization / cost / efficiency logic lives in ./tessie/convert.mjs
 * (unit-tested); this file is the DB orchestrator.
 *
 * Writes via the DIRECT (session, :5432) connection — same as db:migrate, NOT
 * Hyperdrive/6543. Rows are tagged import_source='tessie' so the live poller /
 * reconcile never overwrite them, and re-runs are idempotent (upsert on
 * (vin, started_at) for sessions, (vin, import_source, source_pk) for snapshots).
 *
 * Usage:
 *   DIRECT_URL=postgres://…:5432/postgres \
 *   node scripts/import-tessie.mjs <tesboard-user-email> <export-dir> [options]
 *   pnpm import:tessie <email> ~/Downloads/<VIN> [options]
 *
 * Options:
 *   --dry-run        parse + sessionize + print counts, write NOTHING
 *   --no-snapshots   skip the per-sample vehicle_snapshot stream (sessions only)
 *   --sleep-gap=<m>  minutes of silence that counts as 'asleep' (default 20)
 *
 * Energy: Tessie ships "Energy Remaining (kWh)", so drive/charge energy is the
 * EXACT battery-side delta over the session window (better than the Fleet API's
 * range×efficiency estimate). Pack size + Wh/mi efficiency are derived from the
 * data and written to the vehicle row.
 */
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import postgres from 'postgres'
import {
  avgNonNull,
  classifyChargeLocation,
  clamp,
  computeChargeCost,
  derivePackKwh,
  deriveEfficiencyWhPerMi,
  deriveStates,
  findGeofence,
  firstNonNull,
  lastNonNull,
  maxNonNull,
  msToIso,
  num,
  parseCsv,
  parseTouSchedule,
  positiveDelta,
  sessionizeRuns,
  socEnergyKwh,
  tessieTsToMs,
  toBool,
  toInt,
  whPerMi,
} from './tessie/convert.mjs'

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
const positionals = argv.filter((a) => !a.startsWith('--'))
const email = positionals[0]
const dir = positionals[1]
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}

if (!email || !dir) {
  console.error('Usage: node scripts/import-tessie.mjs <tesboard-user-email> <export-dir> [options]')
  process.exit(1)
}

const DRY = flag('dry-run')
const NO_SNAPSHOTS = flag('no-snapshots')
const SLEEP_GAP_MS = Number(opt('sleep-gap', '20')) * 60_000
const STALE_MS = 6 * 60 * 60 * 1000

const VIN = basename(dir.replace(/\/+$/, ''))
if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(VIN)) {
  console.error(`Folder name "${VIN}" is not a 17-char VIN. Point <export-dir> at the VIN folder.`)
  process.exit(1)
}

const TB_URL = resolve('DIRECT_URL') || resolve('DATABASE_URL')
if (!TB_URL) {
  console.error('Missing DIRECT_URL / DATABASE_URL (use the :5432 session URL, not the 6543 pooler).')
  process.exit(1)
}

const log = (...a) => console.log(...a)
const counts = {}
const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n)

// ── load CSV streams ─────────────────────────────────────────────────────────
function readStream(file) {
  let text
  try {
    text = readFileSync(join(dir, file), 'utf8')
  } catch {
    return null
  }
  return parseCsv(text)
}

// Map a parsed CSV into { ms, ...fields } records via a header→index lookup and a
// per-stream row mapper. Skips rows with an unparseable timestamp.
function mapStream(parsed, mapper) {
  if (!parsed) return []
  const out = []
  for (const row of parsed.rows) {
    const ms = tessieTsToMs(row[0])
    if (ms == null) continue
    out.push({ ms, ...mapper(row) })
  }
  out.sort((a, b) => a.ms - b.ms)
  return out
}

const battery = mapStream(readStream('battery_states.csv'), (r) => ({
  lifetimeUsed: num(r[1]),
  energyRemaining: num(r[2]),
  packCurrent: num(r[3]),
  packVoltage: num(r[4]),
}))
const charging = mapStream(readStream('charging_states.csv'), (r) => ({
  state: r[1] || null,
  soc: toInt(r[2]),
  range: num(r[3]),
  idealRange: num(r[4]),
  chargeRate: num(r[5]),
  current: toInt(r[6]),
  phases: toInt(r[7]),
  power: num(r[8]),
  voltage: toInt(r[9]),
}))
const climate = mapStream(readStream('climate_states.csv'), (r) => ({
  enabled: toBool(r[1]),
  inside: num(r[2]),
  outside: num(r[3]),
}))
const vehicleState = mapStream(readStream('vehicle_states.csv'), (r) => ({
  locked: toBool(r[1]),
  sentry: toBool(r[2]),
}))
const driving = mapStream(readStream('driving_states.csv'), (r) => ({
  lat: num(r[1]),
  lng: num(r[2]),
  shift: r[3] || null,
  odometer: num(r[4]),
  speed: num(r[5]),
}))

if (!battery.length && !charging.length && !driving.length) {
  console.error(`No usable CSV streams found in ${dir}.`)
  process.exit(1)
}

// The four "states" streams share one timestamp set; index them by ms.
const batteryByMs = new Map(battery.map((b) => [b.ms, b]))
const chargingByMs = new Map(charging.map((c) => [c.ms, c]))
const climateByMs = new Map(climate.map((c) => [c.ms, c]))
const vehStateByMs = new Map(vehicleState.map((v) => [v.ms, v]))
// Unified timeline = union of all stream timestamps, sorted.
const allMs = [...new Set([...batteryByMs.keys(), ...chargingByMs.keys(), ...driving.map((d) => d.ms)])].sort(
  (a, b) => a - b,
)

log(`→ VIN ${VIN}: ${allMs.length} sample timestamps`)
log(
  `  battery=${battery.length} charging=${charging.length} climate=${climate.length} vehicle=${vehicleState.length} driving=${driving.length}`,
)
log(`  range ${allMs.length ? msToIso(allMs[0]) : '—'} … ${allMs.length ? msToIso(allMs[allMs.length - 1]) : '—'}`)

// ── window helpers (binary search over a sorted ms array) ────────────────────
function rangeIdx(sortedMs, a, b) {
  // first index with ms >= a, and first index with ms > b
  let lo = 0
  let hi = sortedMs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedMs[mid] < a) lo = mid + 1
    else hi = mid
  }
  const start = lo
  lo = start
  hi = sortedMs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedMs[mid] <= b) lo = mid + 1
    else hi = mid
  }
  return [start, lo]
}
const chargingMs = charging.map((c) => c.ms)
const drivingMs = driving.map((d) => d.ms)

// values of `field` from the states streams (battery/charging/climate) over [a,b]
function windowVals(a, b, src, field) {
  const [lo, hi] = rangeIdx(chargingMs, a, b) // states share charging's ts set
  const out = []
  for (let i = lo; i < hi; i++) {
    const ms = chargingMs[i]
    const rec = src === 'charging' ? chargingByMs.get(ms) : src === 'battery' ? batteryByMs.get(ms) : climateByMs.get(ms)
    out.push(rec ? (rec[field] ?? null) : null)
  }
  return out
}
function drivingWindow(a, b) {
  const [lo, hi] = rangeIdx(drivingMs, a, b)
  return driving.slice(lo, hi)
}
// last known driving position at or before ms (charging stream lacks GPS)
function lastPositionBefore(ms) {
  let lo = 0
  let hi = driving.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (driving[mid].ms <= ms) lo = mid + 1
    else hi = mid
  }
  for (let i = lo - 1; i >= 0; i--) {
    if (driving[i].lat != null && driving[i].lng != null) return driving[i]
  }
  return null
}

// ── derive pack size + LFP flag ──────────────────────────────────────────────
const packPairs = []
for (const c of charging) {
  const b = batteryByMs.get(c.ms)
  if (b) packPairs.push({ socPct: c.soc, remainingKwh: b.energyRemaining })
}
const packKwh = derivePackKwh(packPairs)
const isLfp = packKwh != null && packKwh < 70
log(`→ derived pack ≈ ${packKwh != null ? packKwh.toFixed(2) : '?'} kWh (is_lfp=${isLfp})`)

// ── sessionize ───────────────────────────────────────────────────────────────
// Drives over the driving stream; charges over the charging stream.
const driveRuns = sessionizeRuns(
  driving,
  (s) => s.shift === 'D' || s.shift === 'R' || s.shift === 'N',
  STALE_MS,
)
const chargeRuns = sessionizeRuns(charging, (s) => s.state === 'Charging', STALE_MS)
log(`→ sessionized: ${driveRuns.length} drives, ${chargeRuns.length} charges`)

// Build drive/charge session payloads (pure; energy from Energy Remaining delta).
const drives = driveRuns.map((run) => {
  const a = run.startMs
  const b = run.endMs // last active sample (for end odometer/energy)
  const win = drivingWindow(a, b)
  const odoStart = firstNonNull(win.map((d) => d.odometer))
  const odoEnd = lastNonNull(win.map((d) => d.odometer))
  const distance = odoStart != null && odoEnd != null ? Math.max(0, odoEnd - odoStart) : null
  const remStart = firstNonNull(windowVals(a, b, 'battery', 'energyRemaining'))
  const remEnd = lastNonNull(windowVals(a, b, 'battery', 'energyRemaining'))
  const socStart = firstNonNull(windowVals(a, b, 'charging', 'soc'))
  const socEnd = lastNonNull(windowVals(a, b, 'charging', 'soc'))
  let energy = positiveDelta(remStart, remEnd)
  if (energy == null) energy = socEnergyKwh(socStart, socEnd, packKwh)
  return {
    started_at: msToIso(a),
    ended_at: msToIso(run.closeMs),
    start_odometer: odoStart,
    end_odometer: odoEnd,
    distance_mi: distance,
    duration_s: Math.max(0, Math.round((run.closeMs - a) / 1000)),
    start_lat: firstNonNull(win.map((d) => d.lat)),
    start_lng: firstNonNull(win.map((d) => d.lng)),
    end_lat: lastNonNull(win.map((d) => d.lat)),
    end_lng: lastNonNull(win.map((d) => d.lng)),
    start_battery_level: socStart,
    end_battery_level: socEnd,
    start_range_mi: firstNonNull(windowVals(a, b, 'charging', 'range')),
    end_range_mi: lastNonNull(windowVals(a, b, 'charging', 'range')),
    energy_used_kwh: energy,
    wh_per_mi: whPerMi(energy, distance),
    outside_temp_avg: avgNonNull(windowVals(a, b, 'climate', 'outside')),
    inside_temp_avg: avgNonNull(windowVals(a, b, 'climate', 'inside')),
    speed_max_mph: (() => {
      const m = maxNonNull(win.map((d) => d.speed))
      return m == null ? null : Math.round(m)
    })(),
    source_pk: a,
  }
})

const charges = chargeRuns.map((run) => {
  const a = run.startMs
  const b = run.endMs
  const remStart = firstNonNull(windowVals(a, b, 'battery', 'energyRemaining'))
  const remEnd = lastNonNull(windowVals(a, b, 'battery', 'energyRemaining'))
  let energy = positiveDelta(remEnd, remStart)
  const socStart = firstNonNull(windowVals(a, b, 'charging', 'soc'))
  const socEnd = lastNonNull(windowVals(a, b, 'charging', 'soc'))
  if (energy == null && socStart != null && socEnd != null && socEnd > socStart) {
    energy = ((socEnd - socStart) / 100) * (packKwh ?? 75)
  }
  if (energy != null && packKwh != null) energy = clamp(energy, 0, packKwh)
  const rangeStart = firstNonNull(windowVals(a, b, 'charging', 'range'))
  const rangeEnd = lastNonNull(windowVals(a, b, 'charging', 'range'))
  const superCount = windowVals(a, b, 'charging', 'power').filter((p) => p != null && p >= 25).length
  const source = superCount >= 2 ? 'supercharger' : 'home'
  const pos = lastPositionBefore(a)
  return {
    started_at: msToIso(a),
    ended_at: msToIso(run.closeMs),
    source,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    energy_added_kwh: energy,
    miles_added_rated: rangeStart != null && rangeEnd != null ? rangeEnd - rangeStart : null,
    start_range_mi: rangeStart,
    end_range_mi: rangeEnd,
    start_battery_level: socStart,
    end_battery_level: socEnd,
    outside_temp_avg: avgNonNull(windowVals(a, b, 'climate', 'outside')),
    duration_s: Math.max(0, Math.round((run.closeMs - a) / 1000)),
    source_pk: a,
  }
})

// efficiency from clean charges (mirrors src/server/efficiency.ts)
const effSamples = []
for (const c of charges) {
  const rangeAdded =
    c.start_range_mi != null && c.end_range_mi != null
      ? c.end_range_mi - c.start_range_mi
      : c.miles_added_rated
  if (c.energy_added_kwh != null && c.energy_added_kwh > 0 && rangeAdded != null && rangeAdded > 0) {
    if (c.end_battery_level == null || c.end_battery_level <= 95) {
      effSamples.push({ energyKwh: c.energy_added_kwh, rangeAddedMi: rangeAdded })
    }
  }
}
const effWhPerMi = deriveEfficiencyWhPerMi(effSamples)
log(`→ derived efficiency ≈ ${effWhPerMi != null ? effWhPerMi.toFixed(1) : '?'} Wh/mi (from ${effSamples.length} clean charges)`)

// ── DB connection ────────────────────────────────────────────────────────────
const tb = postgres(TB_URL, { max: 3, prepare: false, idle_timeout: 20 })
let batchId = null

try {
  const [user] = await tb`select id from auth.users where email = ${email} limit 1`
  if (!user) throw new Error(`No tesboard user with email ${email}. Run pnpm user:create first.`)
  const userId = user.id
  log(`→ tesboard user ${email} = ${userId}`)

  // user's cost inputs (electricity_rate + geofences), loaded once for charge cost
  const [rate] = await tb`select * from electricity_rate where user_id = ${userId} limit 1`
  const geofences = await tb`select id, name, lat, lng, radius_m, billing_type, cost_per_unit, session_fee, currency, is_home from geofence where user_id = ${userId}`
  const home = rate
    ? { home_lat: rate.home_lat, home_lng: rate.home_lng, home_radius_m: rate.home_radius_m }
    : null
  const homeRate = rate
    ? {
        flat_rate: rate.flat_rate,
        loss_factor: rate.loss_factor,
        currency: rate.currency,
        tou: parseTouSchedule(rate.tou_schedule),
      }
    : null

  // cutover reference (earliest live snapshot), best-effort
  let cutover = null
  try {
    const [{ cutover_raw } = {}] =
      await tb`select min(recorded_at) as cutover_raw from vehicle_snapshot where user_id = ${userId} and import_source = 'live'`
    cutover = cutover_raw ? new Date(cutover_raw).toISOString() : null
  } catch {
    /* schema may predate import_source — ignore */
  }

  if (!DRY) {
    const [b] = await tb`
      insert into import_batch (user_id, source, status, preferred_range, cutover_at)
      values (${userId}, 'tessie', 'running', 'rated', ${cutover ?? null}) returning id`
    batchId = b.id
    log(`→ import_batch #${batchId}`)
  }

  // 1. vehicle (upsert by vin) ────────────────────────────────────────────────
  if (!DRY) {
    await tb`
      insert into vehicle (vin, user_id, tesla_id, display_name, model, pack_kwh, efficiency_wh_per_mi, is_lfp)
      values (${VIN}, ${userId}, ${VIN}, 'Tesla', 'Model Y', ${packKwh}, ${effWhPerMi != null ? Math.round(effWhPerMi * 100) / 100 : null}, ${isLfp})
      on conflict (vin) do update set
        pack_kwh = coalesce(excluded.pack_kwh, vehicle.pack_kwh),
        efficiency_wh_per_mi = coalesce(excluded.efficiency_wh_per_mi, vehicle.efficiency_wh_per_mi),
        is_lfp = excluded.is_lfp,
        updated_at = now()`
  }
  bump('vehicle')

  // 2. vehicle_snapshot (merged per-sample stream) ────────────────────────────
  if (!NO_SNAPSHOTS) {
    const CHUNK = 500
    let buf = []
    const flush = async () => {
      if (!buf.length) return
      if (!DRY) {
        await tb`insert into vehicle_snapshot ${tb(buf)}
          on conflict (vin, import_source, source_pk) where source_pk is not null do nothing`
      }
      bump('snapshots', buf.length)
      buf = []
    }
    for (const ms of allMs) {
      const c = chargingByMs.get(ms)
      const b = batteryByMs.get(ms)
      const cl = climateByMs.get(ms)
      const v = vehStateByMs.get(ms)
      const dr = drivingRecAt(ms)
      const power = b && b.packCurrent != null && b.packVoltage != null ? (b.packCurrent * b.packVoltage) / 1000 : null
      buf.push({
        vin: VIN,
        user_id: userId,
        recorded_at: msToIso(ms),
        odometer: dr?.odometer ?? null,
        battery_level: c?.soc ?? null,
        usable_battery_level: c?.soc ?? null,
        battery_range: c?.range ?? null,
        est_battery_range: c?.idealRange ?? null,
        charging_state: c?.state ?? null,
        charger_power: c?.power ?? null,
        charger_voltage: c?.voltage ?? null,
        charger_actual_current: c?.current ?? null,
        charger_phases: c?.phases ?? null,
        shift_state: dr?.shift ?? null,
        latitude: dr?.lat ?? null,
        longitude: dr?.lng ?? null,
        speed: dr?.speed ?? null,
        power_kw: power,
        inside_temp: cl?.inside ?? null,
        outside_temp: cl?.outside ?? null,
        is_climate_on: cl?.enabled ?? null,
        sentry_mode: v?.sentry ?? null,
        import_source: 'tessie',
        source_pk: ms,
      })
      if (buf.length >= CHUNK) await flush()
    }
    await flush()
    log(`✓ snapshots: ${counts.snapshots ?? 0}`)
  }

  // 3. charge sessions ────────────────────────────────────────────────────────
  for (const c of charges) {
    const gf = findGeofence(c.lat, c.lng, geofences)
    const verdict = classifyChargeLocation(c.source, c.lat, c.lng, home)
    const locType =
      c.source === 'supercharger' ? 'supercharger' : gf ? (gf.is_home ? 'home' : 'away') : verdict
    const costR = computeChargeCost({
      source: c.source,
      freeSupercharging: false,
      energyAddedKwh: c.energy_added_kwh,
      durationS: c.duration_s,
      geofence: gf
        ? {
            billing_type: gf.billing_type,
            cost_per_unit: gf.cost_per_unit,
            session_fee: gf.session_fee,
            currency: gf.currency,
            is_home: gf.is_home,
          }
        : null,
      homeRate,
      isHome: verdict === 'home',
      startedAt: c.started_at,
      endedAt: c.ended_at,
    })
    if (!DRY) {
      await tb`
        insert into charge_session (vin, user_id, source, started_at, ended_at, lat, lng,
          energy_added_kwh, miles_added_rated, start_range_mi, end_range_mi, start_battery_level,
          end_battery_level, outside_temp_avg, charge_location_type, geofence_id, cost_amount,
          cost_currency, cost_source, rate_applied, import_source, source_pk)
        values (${VIN}, ${userId}, ${c.source}, ${c.started_at}, ${c.ended_at}, ${c.lat}, ${c.lng},
          ${c.energy_added_kwh}, ${c.miles_added_rated}, ${c.start_range_mi}, ${c.end_range_mi},
          ${c.start_battery_level}, ${c.end_battery_level}, ${c.outside_temp_avg}, ${locType},
          ${gf?.id ?? null}, ${costR.cost_amount}, ${costR.cost_currency}, ${costR.cost_source},
          ${costR.rate_applied}, 'tessie', ${c.source_pk})
        on conflict (vin, started_at) where import_source <> 'live' do update set
          ended_at = excluded.ended_at, source = excluded.source,
          energy_added_kwh = excluded.energy_added_kwh, miles_added_rated = excluded.miles_added_rated,
          start_range_mi = excluded.start_range_mi, end_range_mi = excluded.end_range_mi,
          start_battery_level = excluded.start_battery_level, end_battery_level = excluded.end_battery_level,
          outside_temp_avg = excluded.outside_temp_avg, charge_location_type = excluded.charge_location_type,
          geofence_id = excluded.geofence_id, cost_amount = excluded.cost_amount,
          cost_currency = excluded.cost_currency, cost_source = excluded.cost_source,
          rate_applied = excluded.rate_applied, source_pk = excluded.source_pk, updated_at = now()`
    }
    bump('charges')
  }
  log(`✓ charge sessions: ${counts.charges ?? 0}`)

  // 4. drive sessions ─────────────────────────────────────────────────────────
  for (const d of drives) {
    if (!DRY) {
      await tb`
        insert into drive_session (vin, user_id, started_at, ended_at, start_odometer, end_odometer,
          distance_mi, duration_s, start_lat, start_lng, end_lat, end_lng, start_battery_level,
          end_battery_level, start_range_mi, end_range_mi, energy_used_kwh, wh_per_mi, outside_temp_avg,
          inside_temp_avg, speed_max_mph, import_source, source_pk)
        values (${VIN}, ${userId}, ${d.started_at}, ${d.ended_at}, ${d.start_odometer}, ${d.end_odometer},
          ${d.distance_mi}, ${d.duration_s}, ${d.start_lat}, ${d.start_lng}, ${d.end_lat}, ${d.end_lng},
          ${d.start_battery_level}, ${d.end_battery_level}, ${d.start_range_mi}, ${d.end_range_mi},
          ${d.energy_used_kwh}, ${d.wh_per_mi}, ${d.outside_temp_avg}, ${d.inside_temp_avg},
          ${d.speed_max_mph}, 'tessie', ${d.source_pk})
        on conflict (vin, started_at) where import_source <> 'live' do update set
          ended_at = excluded.ended_at, end_odometer = excluded.end_odometer,
          distance_mi = excluded.distance_mi, duration_s = excluded.duration_s,
          end_lat = excluded.end_lat, end_lng = excluded.end_lng,
          end_battery_level = excluded.end_battery_level, start_range_mi = excluded.start_range_mi,
          end_range_mi = excluded.end_range_mi, energy_used_kwh = excluded.energy_used_kwh,
          wh_per_mi = excluded.wh_per_mi, outside_temp_avg = excluded.outside_temp_avg,
          inside_temp_avg = excluded.inside_temp_avg, speed_max_mph = excluded.speed_max_mph,
          source_pk = excluded.source_pk`
    }
    bump('drives')
  }
  log(`✓ drive sessions: ${counts.drives ?? 0}`)

  // 5. vehicle_state intervals (driving / charging / asleep-from-gaps / online) ─
  const driveWin = drives.map((d) => [Date.parse(d.started_at), Date.parse(d.ended_at)])
  const chargeWin = charges.map((c) => [Date.parse(c.started_at), Date.parse(c.ended_at)])
  const inAny = (wins, ms) => wins.some(([s, e]) => ms >= s && ms < e)
  const classify = (ms) => (inAny(chargeWin, ms) ? 'charging' : inAny(driveWin, ms) ? 'driving' : null)
  const intervals = deriveStates(allMs, classify, SLEEP_GAP_MS)
  for (const iv of intervals) {
    if (!DRY) {
      await tb`
        insert into vehicle_state (vin, user_id, state, started_at, ended_at, import_source)
        values (${VIN}, ${userId}, ${iv.state}, ${msToIso(iv.startMs)}, ${msToIso(iv.endMs)}, 'tessie')
        on conflict (vin, started_at) do update set
          ended_at = excluded.ended_at, state = excluded.state`
    }
    bump('states')
  }
  log(`✓ vehicle_state intervals: ${counts.states ?? 0}`)

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
  await tb.end({ timeout: 5 })
}

// ── helper: driving record exactly at ms (driving ts ⊆ states ts) ────────────
function drivingRecAt(ms) {
  // driving is sorted; binary search for exact ms
  let lo = 0
  let hi = driving.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (driving[mid].ms < ms) lo = mid + 1
    else hi = mid
  }
  return driving[lo] && driving[lo].ms === ms ? driving[lo] : null
}
