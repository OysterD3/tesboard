/**
 * Sleep-aware poller + sessionization engine (the heart of the app).
 *
 * One cycle: for each linked user → list vehicles (cheap) → reap stale open
 * sessions → if a vehicle is `online`, read vehicle_data once and append a
 * snapshot, then update open drive/charge sessions from the new snapshot. NEVER
 * calls wake_up; a sleeping car returns ASLEEP and we record state and back off.
 *
 * Runs under the Drizzle owner connection, so every write sets user_id and every
 * read is scoped by user_id explicitly (app-enforced row ownership).
 */
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm'
import { withDb, type Db } from './db'
import {
  anomalyFlag,
  chargeSession,
  driveSession,
  electricityRate,
  geofence,
  softwareUpdate,
  teslaAccount,
  vehicle,
  vehicleSnapshot,
  vehicleState,
} from './schema'
import {
  ASLEEP,
  createTeslaClient,
  getVehicleData,
  listVehicles,
} from './tesla/client.server'
import type { TeslaDriveState, TeslaVehicleData } from './tesla/types'
import type { AnomalyCandidate } from './anomaly'
import { detectEfficiencyDrop, detectSlowCharge } from './anomaly'
import { classifyChargeLocation, findGeofence } from './geo'
import { cachedAddressNear, findOrCreateAddress } from './geocode'
import { computeChargeCost } from './cost'
import { recalculateEfficiency } from './efficiency'
import type { ElectricityRate, Geofence, Json } from '../types/db'

/**
 * Approximate usable pack energy (kWh); used for drive energy estimates.
 * Defaults to ~75 kWh (a typical Model Y / long-range pack). If your vehicle
 * has a different pack size, adjust this to keep Wh/km efficiency accurate.
 */
const PACK_KWH = 75
const SUPERCHARGER_KW_THRESHOLD = 25 // DC fast vs home AC; reconciliation overrides
const SUSTAINED_SUPER_SNAPSHOTS = 2 // need >= N high-power readings to call it Supercharger
const STALE_SESSION_MS = 6 * 60 * 60 * 1000 // auto-close sessions idle longer than this
const MIN_WHPM_DISTANCE_MI = 1 // don't compute Wh/mi for sub-mile (quantization noise)

const UNIQUE_VIOLATION = '23505'
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { code?: string }).code === UNIQUE_VIOLATION
}

export interface PollSummary {
  users: number
  vehiclesPolled: number
  snapshots: number
  asleep: number
  errors: string[]
}

export async function runPollCycle(): Promise<PollSummary> {
  return withDb(async (db) => {
  const summary: PollSummary = { users: 0, vehiclesPolled: 0, snapshots: 0, asleep: 0, errors: [] }

  const accounts = await db
    .select({ user_id: teslaAccount.user_id })
    .from(teslaAccount)

  for (const acct of accounts) {
    summary.users++
    try {
      await pollUser(db, acct.user_id, summary)
    } catch (e) {
      summary.errors.push(`user ${acct.user_id}: ${(e as Error).message}`)
    }
  }
  return summary
  })
}

async function pollUser(db: Db, userId: string, summary: PollSummary): Promise<void> {
  const ctx = await createTeslaClient(db, userId)
  const vehicles = await listVehicles(ctx)

  for (const v of vehicles) {
    await reapStaleSessions(db, userId, v.vin, summary)

    try {
      await db
        .update(vehicle)
        .set({ last_state: v.state, updated_at: new Date().toISOString() })
        .where(and(eq(vehicle.vin, v.vin), eq(vehicle.user_id, userId)))
    } catch (e) {
      summary.errors.push(`vehicle ${v.vin}: ${(e as Error).message}`)
    }

    // State-interval history (online/asleep/offline) — runs for every vehicle,
    // even sleeping ones (that's the point: a sleep timeline + drain attribution).
    await recordStateTransition(db, userId, v.vin, v.state, summary)

    if (v.state !== 'online') {
      summary.asleep++
      continue // back off — do NOT wake the car
    }

    const data = await getVehicleData(ctx, String(v.id))
    if (data === ASLEEP) {
      summary.asleep++
      continue
    }

    // Firmware version history (best-effort; never abort the cycle).
    await recordSoftwareUpdate(db, userId, v.vin, data.vehicle_state?.car_version ?? null, summary)

    const recordedAt = new Date().toISOString()
    const snapErr = await insertSnapshot(db, userId, v.vin, recordedAt, data)
    if (snapErr) {
      // Don't sessionize from an incomplete snapshot set.
      summary.errors.push(`snapshot ${v.vin}: ${snapErr}`)
      continue
    }
    summary.snapshots++
    summary.vehiclesPolled++

    await updateChargeSession(db, userId, v.vin, recordedAt, data, summary)
    await updateDriveSession(db, userId, v.vin, recordedAt, data, summary)
  }
}

// Plausible range for a real reading time (2015-01-01 .. 2100-01-01), in ms.
const MIN_TS_MS = Date.UTC(2015, 0, 1)
const MAX_TS_MS = Date.UTC(2100, 0, 1)

/**
 * Resolve the location "as of" time. Tesla's `drive_state.gps_as_of` is nominally
 * Unix *seconds*, but a parked/asleep car often returns a garbage value (e.g. a
 * large negative number, which `* 1000` turns into a 1943 date). Use it only when
 * it lands in a sane range; otherwise fall back to the drive_state `timestamp`
 * (Unix ms), then null (callers fall back to the snapshot's recorded_at).
 */
function locationAsOf(ds: TeslaDriveState): string | null {
  if (typeof ds.gps_as_of === 'number') {
    const ms = ds.gps_as_of * 1000
    if (ms >= MIN_TS_MS && ms <= MAX_TS_MS) return new Date(ms).toISOString()
  }
  if (typeof ds.timestamp === 'number' && ds.timestamp >= MIN_TS_MS && ds.timestamp <= MAX_TS_MS) {
    return new Date(ds.timestamp).toISOString()
  }
  return null
}

async function insertSnapshot(
  db: Db,
  userId: string,
  vin: string,
  recordedAt: string,
  data: TeslaVehicleData,
): Promise<string | null> {
  const cs = data.charge_state ?? {}
  const ds = data.drive_state ?? {}
  const vs = data.vehicle_state ?? {}
  const cl = data.climate_state ?? {}
  try {
    await db.insert(vehicleSnapshot).values({
      vin,
      user_id: userId,
      recorded_at: recordedAt,
      odometer: vs.odometer ?? null,
      battery_level: cs.battery_level ?? null,
      usable_battery_level: cs.usable_battery_level ?? null,
      battery_range: cs.battery_range ?? null,
      est_battery_range: cs.est_battery_range ?? null,
      charge_energy_added: cs.charge_energy_added ?? null,
      charging_state: cs.charging_state ?? null,
      charger_power: cs.charger_power ?? null,
      shift_state: ds.shift_state ?? null,
      inside_temp: cl.inside_temp ?? null,
      outside_temp: cl.outside_temp ?? null,
      tpms_fl: vs.tpms_pressure_fl ?? null,
      tpms_fr: vs.tpms_pressure_fr ?? null,
      tpms_rl: vs.tpms_pressure_rl ?? null,
      tpms_rr: vs.tpms_pressure_rr ?? null,
      latitude: ds.latitude ?? null,
      longitude: ds.longitude ?? null,
      speed: ds.speed ?? null,
      charger_voltage: cs.charger_voltage ?? null,
      power_kw: ds.power ?? null,
      gps_as_of: locationAsOf(ds),
      raw_json: data as unknown as Json,
    })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

// ── stale-session reaper ─────────────────────────────────────────────────────
// If the car goes offline mid-charge/mid-drive, the closing observation may never
// arrive. Close any open session whose last activity is older than the threshold
// so it can't stay open forever and swallow the next genuine session.
async function reapStaleSessions(
  db: Db,
  userId: string,
  vin: string,
  summary: PollSummary,
): Promise<void> {
  const cutoff = Date.now() - STALE_SESSION_MS

  const openCharge = await openSession(db, chargeSession, vin, userId)
  if (openCharge) {
    const last = await lastSnapshotTime(db, vin, userId)
    const lastActivity = Math.max(
      new Date(openCharge.started_at).getTime(),
      last ? new Date(last).getTime() : 0,
    )
    if (lastActivity < cutoff) {
      await closeChargeSession(db, userId, vin, openCharge, last ?? openCharge.started_at, summary)
      summary.errors.push(`reaped stale charge session for ${vin}`)
    }
  }

  const openDrive = await openSession(db, driveSession, vin, userId)
  if (openDrive) {
    const last = await lastSnapshotTime(db, vin, userId)
    const lastActivity = Math.max(
      new Date(openDrive.started_at).getTime(),
      last ? new Date(last).getTime() : 0,
    )
    if (lastActivity < cutoff) {
      await closeDriveSession(db, userId, vin, openDrive, last ?? openDrive.started_at, summary)
      summary.errors.push(`reaped stale drive session for ${vin}`)
    }
  }
}

// ── charge sessionization ────────────────────────────────────────────────────
async function updateChargeSession(
  db: Db,
  userId: string,
  vin: string,
  recordedAt: string,
  data: TeslaVehicleData,
  summary: PollSummary,
): Promise<void> {
  const cs = data.charge_state ?? {}
  const ds = data.drive_state ?? {}
  const isCharging = cs.charging_state === 'Charging'
  const open = await openSession(db, chargeSession, vin, userId)

  if (isCharging && !open) {
    const source =
      (cs.charger_power ?? 0) >= SUPERCHARGER_KW_THRESHOLD ? 'supercharger' : 'home'
    try {
      await db.insert(chargeSession).values({
        vin,
        user_id: userId,
        source,
        started_at: recordedAt,
        lat: ds.latitude ?? null,
        lng: ds.longitude ?? null,
        energy_added_kwh: cs.charge_energy_added ?? 0,
        cost_source: 'computed',
      })
    } catch (e) {
      // 23505 = another concurrent cycle already opened one; harmless, ignore.
      if (!isUniqueViolation(e)) {
        throw new Error(`open charge session ${vin}: ${(e as Error).message}`)
      }
    }
    return
  }
  if (isCharging && open) {
    // Never let a mid-session counter reset lower the stored running total.
    const incoming = cs.charge_energy_added ?? 0
    await db
      .update(chargeSession)
      .set({
        energy_added_kwh: Math.max(incoming, open.energy_added_kwh ?? 0),
        updated_at: recordedAt,
      })
      .where(eq(chargeSession.id, open.id))
    return
  }
  if (!isCharging && open) {
    await closeChargeSession(db, userId, vin, open, recordedAt, summary)
  }
}

async function closeChargeSession(
  db: Db,
  userId: string,
  vin: string,
  open: any,
  endedAt: string,
  summary: PollSummary,
): Promise<void> {
  const agg = await aggregateSnapshots(db, vin, userId, open.started_at, endedAt)
  const energyKwh = agg.energyAdded ?? open.energy_added_kwh ?? 0
  const milesAdded =
    agg.endRange != null && agg.startRange != null ? agg.endRange - agg.startRange : null
  // Sustained high power (>= N readings), not a single noisy spike, marks a Supercharger.
  const source =
    open.source !== 'home'
      ? open.source
      : agg.superSnapshotCount >= SUSTAINED_SUPER_SNAPSHOTS
        ? 'supercharger'
        : 'home'

  // Geofence + cost. Match the start coords against the user's named zones
  // (nearest-wins); fall back to the legacy home geofence on electricity_rate.
  const rate = await getRate(db, userId)
  const geofences = (await db
    .select()
    .from(geofence)
    .where(eq(geofence.user_id, userId))) as Geofence[]
  const gf = findGeofence(open.lat, open.lng, geofences)
  const homeConfigured = rate?.home_lat != null && rate?.home_lng != null

  const chargeLocationType =
    source === 'supercharger'
      ? 'supercharger'
      : gf
        ? gf.is_home
          ? 'home'
          : 'away'
        : classifyChargeLocation(source, open.lat, open.lng, rate)

  // Legacy fallback: before any home/zone is configured, keep costing home AC
  // charges so existing behaviour doesn't silently vanish.
  const treatAsHome =
    chargeLocationType === 'home' ||
    (!homeConfigured && geofences.length === 0 && source !== 'supercharger')

  const durationS = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(open.started_at).getTime()) / 1000),
  )
  const [veh] = await db
    .select({ free_supercharging: vehicle.free_supercharging })
    .from(vehicle)
    .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
    .limit(1)

  const costR = computeChargeCost({
    source,
    freeSupercharging: veh?.free_supercharging ?? false,
    energyAddedKwh: energyKwh,
    durationS,
    geofence: gf
      ? {
          billing_type: gf.billing_type,
          cost_per_unit: gf.cost_per_unit,
          session_fee: gf.session_fee,
          currency: gf.currency,
          is_home: gf.is_home,
        }
      : null,
    homeRate: rate
      ? { flat_rate: rate.flat_rate, loss_factor: rate.loss_factor, currency: rate.currency }
      : null,
    isHome: treatAsHome,
  })

  try {
    await db
      .update(chargeSession)
      .set({
        ended_at: endedAt,
        source,
        charge_location_type: chargeLocationType,
        geofence_id: gf?.id ?? null,
        energy_added_kwh: energyKwh,
        miles_added_rated: milesAdded,
        start_range_mi: agg.startRange,
        end_range_mi: agg.endRange,
        start_battery_level: agg.startBatteryLevel,
        end_battery_level: agg.endBatteryLevel,
        outside_temp_avg: agg.avgOutsideTemp,
        cost_amount: costR.cost_amount,
        cost_currency: costR.cost_currency,
        // supercharger paid → 'computed' here, reconciliation fills tesla_billed.
        cost_source: costR.cost_source,
        rate_applied: costR.rate_applied,
        updated_at: endedAt,
      })
      .where(eq(chargeSession.id, open.id))
  } catch (e) {
    throw new Error(`close charge session ${vin}: ${(e as Error).message}`)
  }

  // Notify-only: flag a slow charge vs this location's usual power. Best-effort —
  // never let a detection error abort sessionization.
  try {
    const candidate = await detectSlowCharge({
      db,
      userId,
      vin,
      chargeId: open.id,
      startedAt: open.started_at,
      lat: open.lat,
      lng: open.lng,
      avgKw: agg.avgChargerPower,
      energyKwh,
      endBatteryLevel: agg.endBatteryLevel,
    })
    if (candidate) await insertAnomaly(db, userId, vin, candidate, { chargeId: open.id })
  } catch (e) {
    summary.errors.push(`slow-charge detect ${vin}: ${(e as Error).message}`)
  }

  // Refresh the per-vehicle efficiency factor from the now-larger charge history.
  try {
    await recalculateEfficiency(db, userId, vin)
  } catch (e) {
    summary.errors.push(`efficiency recalc ${vin}: ${(e as Error).message}`)
  }
}

// ── drive sessionization ─────────────────────────────────────────────────────
async function updateDriveSession(
  db: Db,
  userId: string,
  vin: string,
  recordedAt: string,
  data: TeslaVehicleData,
  summary: PollSummary,
): Promise<void> {
  const ds = data.drive_state ?? {}
  const driving = ds.shift_state === 'D' || ds.shift_state === 'R' || ds.shift_state === 'N'
  const open = await openSession(db, driveSession, vin, userId)

  if (driving && !open) {
    const cs = data.charge_state ?? {}
    try {
      await db.insert(driveSession).values({
        vin,
        user_id: userId,
        started_at: recordedAt,
        start_odometer: data.vehicle_state?.odometer ?? null,
        start_lat: ds.latitude ?? null,
        start_lng: ds.longitude ?? null,
        start_battery_level: cs.battery_level ?? null,
      })
    } catch (e) {
      if (!isUniqueViolation(e)) {
        throw new Error(`open drive session ${vin}: ${(e as Error).message}`)
      }
    }
    return
  }
  if (!driving && open) {
    await closeDriveSession(db, userId, vin, open, recordedAt, summary)
  }
}

/** Close a drive session using the last snapshot in the window (works for the
 *  normal path and the stale reaper alike). */
/**
 * Resolve a point to an `address.id` at drive-close. Always tries the free cache
 * first; only when `allowNetwork` (the drive's END / new-destination case) does it
 * fall back to a single Nominatim geocode. Returns null — never throws — so a
 * geocoding hiccup can't break the poll.
 */
async function linkDriveAddress(
  db: Db,
  userId: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  allowNetwork: boolean,
): Promise<number | null> {
  if (lat == null || lng == null) return null
  const cached = await cachedAddressNear(db, userId, lat, lng)
  if (cached != null || !allowNetwork) return cached
  try {
    return await findOrCreateAddress(db, userId, lat, lng)
  } catch {
    return null
  }
}

async function closeDriveSession(
  db: Db,
  userId: string,
  vin: string,
  open: any,
  endedAt: string,
  summary: PollSummary,
): Promise<void> {
  const last = await lastSnapshotRow(db, vin, userId, endedAt)
  const endOdo = last?.odometer ?? null
  const distance =
    endOdo != null && open.start_odometer != null ? endOdo - open.start_odometer : null
  const agg = await aggregateSnapshots(db, vin, userId, open.started_at, endedAt)
  const [veh] = await db
    .select({ pack_kwh: vehicle.pack_kwh, eff: vehicle.efficiency_wh_per_mi })
    .from(vehicle)
    .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
    .limit(1)
  const startBL = open.start_battery_level
  const endBL = last?.battery_level ?? null
  const rangeDeltaMi =
    agg.startRange != null && agg.endRange != null ? agg.startRange - agg.endRange : null

  // Prefer rated-range-drop × per-vehicle efficiency (TeslaMate's method); fall
  // back to SOC-delta × pack size. battery_level is integer %, and the car can
  // net-charge (regen / N while plugged) — clamp negatives to null.
  const packKwh = veh?.pack_kwh ?? PACK_KWH
  let energyUsed: number | null = null
  if (rangeDeltaMi != null && rangeDeltaMi > 0 && veh?.eff) {
    energyUsed = (rangeDeltaMi * veh.eff) / 1000
  } else if (startBL != null && endBL != null) {
    const raw = ((startBL - endBL) / 100) * packKwh
    energyUsed = raw >= 0 ? raw : null
  }
  const whPerMi =
    energyUsed != null && distance != null && distance >= MIN_WHPM_DISTANCE_MI
      ? (energyUsed * 1000) / distance
      : null
  const durationS = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(open.started_at).getTime()) / 1000),
  )

  // Name the drive's endpoints at close. The START is almost always a place you've
  // left before (usually the previous drive's already-geocoded destination), so a
  // free cache lookup suffices. The END is where you may be NEW, so it's cache-first
  // then ONE Nominatim geocode — drive closes are infrequent (a few/day), well within
  // Nominatim's ~1 req/s policy. Geocoding never blocks or fails the poll cycle.
  const startAddrId = await linkDriveAddress(db, userId, open.start_lat, open.start_lng, false)
  const endAddrId = await linkDriveAddress(db, userId, last?.latitude, last?.longitude, true)

  try {
    await db
      .update(driveSession)
      .set({
        ended_at: endedAt,
        end_odometer: endOdo,
        distance_mi: distance,
        duration_s: durationS,
        end_lat: last?.latitude ?? null,
        end_lng: last?.longitude ?? null,
        start_address_id: startAddrId,
        end_address_id: endAddrId,
        end_battery_level: endBL,
        start_range_mi: agg.startRange,
        end_range_mi: agg.endRange,
        energy_used_kwh: energyUsed,
        wh_per_mi: whPerMi,
        outside_temp_avg: agg.avgOutsideTemp,
        inside_temp_avg: agg.avgInsideTemp,
        speed_max_mph: agg.maxSpeed != null ? Math.round(agg.maxSpeed) : null,
      })
      .where(eq(driveSession.id, open.id))
  } catch (e) {
    throw new Error(`close drive session ${vin}: ${(e as Error).message}`)
  }

  // Notify-only: flag an efficiency drop vs the trailing median. Best-effort.
  try {
    const candidate = await detectEfficiencyDrop({
      db,
      userId,
      vin,
      driveId: open.id,
      whPerMi,
      distanceMi: distance,
    })
    if (candidate) await insertAnomaly(db, userId, vin, candidate, { driveId: open.id })
  } catch (e) {
    summary.errors.push(`efficiency-drop detect ${vin}: ${(e as Error).message}`)
  }
}

/** Insert an anomaly flag, ignoring the partial-unique-index dupe (a flag of this
 *  type already exists for this source row). */
async function insertAnomaly(
  db: Db,
  userId: string,
  vin: string,
  c: AnomalyCandidate,
  ref: { chargeId?: number; driveId?: number },
): Promise<void> {
  try {
    await db.insert(anomalyFlag).values({
      vin,
      user_id: userId,
      type: c.type,
      severity: c.severity,
      message: c.message,
      related_charge_id: ref.chargeId ?? null,
      related_drive_id: ref.driveId ?? null,
      observed: c.observed,
      baseline: c.baseline,
      detail: c.detail,
    })
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function openSession(
  db: Db,
  table: typeof chargeSession | typeof driveSession,
  vin: string,
  userId: string,
): Promise<any | null> {
  const rows = await db
    .select()
    .from(table)
    .where(and(eq(table.vin, vin), eq(table.user_id, userId), isNull(table.ended_at)))
    .orderBy(desc(table.started_at))
    .limit(1)
  return rows[0] ?? null
}

async function aggregateSnapshots(
  db: Db,
  vin: string,
  userId: string,
  fromISO: string,
  toISO: string,
) {
  const rows = await db
    .select({
      battery_range: vehicleSnapshot.battery_range,
      battery_level: vehicleSnapshot.battery_level,
      charge_energy_added: vehicleSnapshot.charge_energy_added,
      charger_power: vehicleSnapshot.charger_power,
      outside_temp: vehicleSnapshot.outside_temp,
      inside_temp: vehicleSnapshot.inside_temp,
      speed: vehicleSnapshot.speed,
      recorded_at: vehicleSnapshot.recorded_at,
    })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.vin, vin),
        eq(vehicleSnapshot.user_id, userId),
        gte(vehicleSnapshot.recorded_at, fromISO),
        lte(vehicleSnapshot.recorded_at, toISO),
      ),
    )
    .orderBy(asc(vehicleSnapshot.recorded_at))
  const ranges = rows.map((r) => r.battery_range).filter((n): n is number => n != null)
  const energies = rows.map((r) => r.charge_energy_added).filter((n): n is number => n != null)
  const levels = rows.map((r) => r.battery_level).filter((n): n is number => n != null)
  const powers = rows.map((r) => r.charger_power).filter((n): n is number => n != null && n > 0)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const outsideTemps = rows.map((r) => r.outside_temp).filter((n): n is number => n != null)
  const insideTemps = rows.map((r) => r.inside_temp).filter((n): n is number => n != null)
  const speeds = rows.map((r) => r.speed).filter((n): n is number => n != null)
  const superSnapshotCount = rows.filter(
    (r) => (r.charger_power ?? 0) >= SUPERCHARGER_KW_THRESHOLD,
  ).length
  const avgChargerPower = powers.length
    ? powers.reduce((a, b) => a + b, 0) / powers.length
    : null

  // charge_energy_added resets to 0 at each physical charge start and rises
  // monotonically. Sum per-segment peaks so a missed unplug/replug boundary in
  // one local session doesn't under-count (Math.max would keep only the larger).
  let energyAdded: number | null = null
  if (energies.length) {
    let total = 0
    let segPeak = 0
    let prev = -Infinity
    for (const e of energies) {
      if (e < prev) {
        total += segPeak
        segPeak = e
      } else {
        segPeak = Math.max(segPeak, e)
      }
      prev = e
    }
    energyAdded = total + segPeak
  }

  return {
    startRange: ranges.at(0) ?? null,
    endRange: ranges.at(-1) ?? null,
    startBatteryLevel: levels.at(0) ?? null,
    endBatteryLevel: levels.at(-1) ?? null,
    avgChargerPower,
    energyAdded,
    superSnapshotCount,
    avgOutsideTemp: avg(outsideTemps),
    avgInsideTemp: avg(insideTemps),
    maxSpeed: speeds.length ? Math.max(...speeds) : null,
  }
}

async function lastSnapshotTime(db: Db, vin: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ recorded_at: vehicleSnapshot.recorded_at })
    .from(vehicleSnapshot)
    .where(and(eq(vehicleSnapshot.vin, vin), eq(vehicleSnapshot.user_id, userId)))
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(1)
  return rows[0]?.recorded_at ?? null
}

async function lastSnapshotRow(
  db: Db,
  vin: string,
  userId: string,
  toISO: string,
): Promise<{
  odometer: number | null
  battery_level: number | null
  latitude: number | null
  longitude: number | null
} | null> {
  const rows = await db
    .select({
      odometer: vehicleSnapshot.odometer,
      battery_level: vehicleSnapshot.battery_level,
      latitude: vehicleSnapshot.latitude,
      longitude: vehicleSnapshot.longitude,
    })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.vin, vin),
        eq(vehicleSnapshot.user_id, userId),
        lte(vehicleSnapshot.recorded_at, toISO),
      ),
    )
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(1)
  return rows[0] ?? null
}

// ── state-interval + firmware tracking ───────────────────────────────────────
/** Close the open state interval and open a new one when the state changes. */
async function recordStateTransition(
  db: Db,
  userId: string,
  vin: string,
  state: string,
  summary: PollSummary,
): Promise<void> {
  try {
    const [open] = await db
      .select({ id: vehicleState.id, state: vehicleState.state })
      .from(vehicleState)
      .where(and(eq(vehicleState.vin, vin), eq(vehicleState.user_id, userId), isNull(vehicleState.ended_at)))
      .orderBy(desc(vehicleState.started_at))
      .limit(1)
    if (open && open.state === state) return // unchanged — nothing to do
    const now = new Date().toISOString()
    if (open) {
      await db.update(vehicleState).set({ ended_at: now }).where(eq(vehicleState.id, open.id))
    }
    try {
      await db.insert(vehicleState).values({ vin, user_id: userId, state, started_at: now })
    } catch (e) {
      if (!isUniqueViolation(e)) throw e // a concurrent cycle opened it — fine
    }
  } catch (e) {
    summary.errors.push(`state track ${vin}: ${(e as Error).message}`)
  }
}

/** Record a firmware version change as a software_update interval. */
async function recordSoftwareUpdate(
  db: Db,
  userId: string,
  vin: string,
  version: string | null,
  summary: PollSummary,
): Promise<void> {
  if (!version) return
  try {
    const [open] = await db
      .select({ id: softwareUpdate.id, version: softwareUpdate.version })
      .from(softwareUpdate)
      .where(and(eq(softwareUpdate.vin, vin), eq(softwareUpdate.user_id, userId), isNull(softwareUpdate.ended_at)))
      .orderBy(desc(softwareUpdate.started_at))
      .limit(1)
    if (open && open.version === version) return
    const now = new Date().toISOString()
    if (open) {
      await db.update(softwareUpdate).set({ ended_at: now }).where(eq(softwareUpdate.id, open.id))
    }
    try {
      await db.insert(softwareUpdate).values({ vin, user_id: userId, version, started_at: now })
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
    }
  } catch (e) {
    summary.errors.push(`update track ${vin}: ${(e as Error).message}`)
  }
}

async function getRate(db: Db, userId: string): Promise<ElectricityRate | null> {
  const rows = await db
    .select()
    .from(electricityRate)
    .where(eq(electricityRate.user_id, userId))
    .limit(1)
  return (rows[0] as ElectricityRate) ?? null
}
