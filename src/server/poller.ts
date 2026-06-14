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
import { getDb, type Db } from './db'
import {
  anomalyFlag,
  chargeSession,
  driveSession,
  electricityRate,
  teslaAccount,
  vehicle,
  vehicleSnapshot,
} from './schema'
import {
  ASLEEP,
  createTeslaClient,
  getVehicleData,
  listVehicles,
} from './tesla/client.server'
import type { TeslaVehicleData } from './tesla/types'
import type { AnomalyCandidate } from './anomaly'
import { detectEfficiencyDrop, detectSlowCharge } from './anomaly'
import { classifyChargeLocation } from './geo'
import type { ElectricityRate, Json } from '../types/db'

/** Approximate usable pack energy (kWh) for a Model Y; used for drive energy estimates. */
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
  const db = getDb()
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

    if (v.state !== 'online') {
      summary.asleep++
      continue // back off — do NOT wake the car
    }

    const data = await getVehicleData(ctx, String(v.id))
    if (data === ASLEEP) {
      summary.asleep++
      continue
    }

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
      gps_as_of: ds.gps_as_of ? new Date(ds.gps_as_of * 1000).toISOString() : null,
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

  // Geofence verdict (home | away | supercharger | unknown) from the start coords.
  const rate = await getRate(db, userId)
  const chargeLocationType = classifyChargeLocation(source, open.lat, open.lng, rate)
  const homeConfigured = rate?.home_lat != null && rate?.home_lng != null

  // Apply the home rate to non-Supercharger charges. Once a home geofence IS
  // configured, only charges inside it get the home rate (away AC charges no
  // longer silently get it); before configuration we keep the prior behavior so
  // existing home cost doesn't vanish.
  const applyHomeCost =
    source !== 'supercharger' && (!homeConfigured || chargeLocationType === 'home')
  let cost: number | null = null
  let costCurrency: string | null = null
  let rateApplied: number | null = null
  if (applyHomeCost && rate?.flat_rate != null && energyKwh) {
    rateApplied = Number(rate.flat_rate)
    costCurrency = rate.currency
    cost = energyKwh * rateApplied * Number(rate.loss_factor ?? 1.1)
  }

  try {
    await db
      .update(chargeSession)
      .set({
        ended_at: endedAt,
        source,
        charge_location_type: chargeLocationType,
        energy_added_kwh: energyKwh,
        miles_added_rated: milesAdded,
        cost_amount: cost,
        cost_currency: costCurrency,
        cost_source: 'computed', // supercharger cost is filled by reconciliation
        rate_applied: rateApplied,
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
  const startBL = open.start_battery_level
  const endBL = last?.battery_level ?? null
  // battery_level is integer %, and the car can net-charge (regen / N while plugged)
  // during a window — clamp negatives to null rather than poison the stats.
  const rawEnergy =
    startBL != null && endBL != null ? ((startBL - endBL) / 100) * PACK_KWH : null
  const energyUsed = rawEnergy != null && rawEnergy >= 0 ? rawEnergy : null
  const whPerMi =
    energyUsed != null && distance != null && distance >= MIN_WHPM_DISTANCE_MI
      ? (energyUsed * 1000) / distance
      : null
  const durationS = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(open.started_at).getTime()) / 1000),
  )

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
        end_battery_level: endBL,
        energy_used_kwh: energyUsed,
        wh_per_mi: whPerMi,
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
    endBatteryLevel: levels.at(-1) ?? null,
    avgChargerPower,
    energyAdded,
    superSnapshotCount,
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

async function getRate(db: Db, userId: string): Promise<ElectricityRate | null> {
  const rows = await db
    .select()
    .from(electricityRate)
    .where(eq(electricityRate.user_id, userId))
    .limit(1)
  return (rows[0] as ElectricityRate) ?? null
}
