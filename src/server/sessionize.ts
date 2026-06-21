/**
 * Runtime-agnostic sessionization engine.
 *
 * Extracted VERBATIM (behaviour-preserving) from poller.ts so it runs in BOTH
 * workerd (the Cloudflare poll cron, Hyperdrive-bridged DATABASE_URL) AND plain
 * Node (the self-hosted telemetry adapter, direct :5432). This module has NO
 * Tesla / REST / Cloudflare / workerd imports — the only coupling to a data
 * source is the structural `SnapshotInput` shape that callers build.
 *
 * Contract: every function takes `db: Db` as its first arg and the CALLER owns
 * the connection lifecycle. The module NEVER calls getDb() itself, so it works
 * under whatever request-scoped client is passed in.
 *
 * Runs under the Drizzle owner connection, so every write sets user_id and every
 * read is scoped by user_id explicitly (app-enforced row ownership).
 */
import { and, asc, desc, eq, gte, isNull, lt, lte } from 'drizzle-orm'
import type { Db } from './db'
import {
  anomalyFlag,
  chargeSession,
  driveSession,
  electricityRate,
  geofence,
  softwareUpdate,
  vehicle,
  vehicleSnapshot,
  vehicleState,
} from './schema'
import type { AnomalyCandidate } from './anomaly'
import { detectEfficiencyDrop, detectSlowCharge } from './anomaly'
import { classifyChargeLocation, findGeofence } from './geo'
import { cachedAddressNear, findOrCreateAddress } from './geocode'
import { computeChargeCost, parseTouSchedule } from './cost'
import { recalculateEfficiency } from './efficiency'
import { sumChargeEnergyAdded } from '../lib/analytics-vm'
import type { ElectricityRate, Geofence, Json } from '../types/db'

/**
 * Approximate usable pack energy (kWh); used for drive energy estimates.
 * Defaults to ~75 kWh (a typical Model Y / long-range pack). If your vehicle
 * has a different pack size, adjust this to keep Wh/km efficiency accurate.
 */
export const PACK_KWH = 75
export const SUPERCHARGER_KW_THRESHOLD = 25 // DC fast vs home AC; reconciliation overrides
export const SUSTAINED_SUPER_SNAPSHOTS = 2 // need >= N high-power readings to call it Supercharger
export const STALE_SESSION_MS = 6 * 60 * 60 * 1000 // auto-close sessions idle longer than this
export const MIN_WHPM_DISTANCE_MI = 1 // don't compute Wh/mi for sub-mile (quantization noise)

const UNIQUE_VIOLATION = '23505'
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { code?: string }).code === UNIQUE_VIOLATION
}

export interface PollSummary {
  users: number
  vehiclesPolled: number
  snapshots: number
  asleep: number
  errors: string[]
}

export function emptyPollSummary(): PollSummary {
  return { users: 0, vehiclesPolled: 0, snapshots: 0, asleep: 0, errors: [] }
}

/**
 * The flat, runtime-agnostic snapshot shape that BOTH the REST poller and the
 * telemetry adapter build. Mirrors EXACTLY the columns insertSnapshot writes.
 * The poller maps a TeslaVehicleData into this; the adapter maps coalesced MQTT
 * deltas into this — neither imports the other's types.
 */
export interface SnapshotInput {
  recordedAt: string // ISO; caller's clock
  odometer: number | null
  battery_level: number | null
  usable_battery_level: number | null
  battery_range: number | null
  est_battery_range: number | null
  charge_energy_added: number | null
  charging_state: string | null // Tesla-style 'Charging' | 'Stopped' | ...
  charger_power: number | null // kW
  shift_state: string | null // 'P' | 'R' | 'N' | 'D' | null (Tesla-style)
  inside_temp: number | null
  outside_temp: number | null
  tpms_fl: number | null
  tpms_fr: number | null
  tpms_rl: number | null
  tpms_rr: number | null
  latitude: number | null
  longitude: number | null
  speed: number | null
  charger_voltage: number | null
  charger_actual_current: number | null
  charger_phases: number | null
  power_kw: number | null
  sentry_mode: boolean | null
  is_climate_on: boolean | null
  is_preconditioning: boolean | null
  gps_as_of: string | null
  raw_json: unknown
  importSource?: string // defaults to 'live'
}

export async function insertSnapshot(
  db: Db,
  userId: string,
  vin: string,
  snap: SnapshotInput,
): Promise<string | null> {
  try {
    await db.insert(vehicleSnapshot).values({
      vin,
      user_id: userId,
      recorded_at: snap.recordedAt,
      odometer: snap.odometer,
      battery_level: snap.battery_level,
      usable_battery_level: snap.usable_battery_level,
      battery_range: snap.battery_range,
      est_battery_range: snap.est_battery_range,
      charge_energy_added: snap.charge_energy_added,
      charging_state: snap.charging_state,
      charger_power: snap.charger_power,
      shift_state: snap.shift_state,
      inside_temp: snap.inside_temp,
      outside_temp: snap.outside_temp,
      tpms_fl: snap.tpms_fl,
      tpms_fr: snap.tpms_fr,
      tpms_rl: snap.tpms_rl,
      tpms_rr: snap.tpms_rr,
      latitude: snap.latitude,
      longitude: snap.longitude,
      speed: snap.speed,
      charger_voltage: snap.charger_voltage,
      charger_actual_current: snap.charger_actual_current,
      charger_phases: snap.charger_phases,
      power_kw: snap.power_kw,
      sentry_mode: snap.sentry_mode,
      is_climate_on: snap.is_climate_on,
      is_preconditioning: snap.is_preconditioning,
      gps_as_of: snap.gps_as_of,
      raw_json: snap.raw_json as Json,
      import_source: snap.importSource ?? 'live',
    })
    // Drive-granular liveness: stamp the vehicle with the latest ingest time so a
    // silent VIN can be detected by checkLiveness. Best-effort — a failure here
    // must not invalidate the (successful) snapshot insert.
    try {
      await db
        .update(vehicle)
        .set({ last_ingest_at: snap.recordedAt })
        .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
    } catch {
      /* ignore — snapshot already persisted */
    }
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/**
 * Close any open drive/charge session for a vehicle, now. The burst Durable
 * Object calls this when it has confirmed (past hysteresis) the car is no longer
 * driving/charging, since it polls with deferClose=true and never closes inline.
 */
export async function closeOpenSessions(
  db: Db,
  userId: string,
  vin: string,
  endedAt?: string,
): Promise<void> {
  const summary = emptyPollSummary()
  // Default the close time to the LAST snapshot's recorded_at, not a fresh "now":
  // with hysteresis the close lands a couple polls after the car parked, and a
  // "now" that fell before the last snapshot under cross-isolate clock skew would
  // drop that snapshot from the aggregate window (losing end odometer/range/SOC).
  // Mirrors reapStaleSessions.
  const end = endedAt ?? (await lastSnapshotTime(db, vin, userId)) ?? new Date().toISOString()
  const openCharge = await openSession(db, chargeSession, vin, userId)
  if (openCharge) await closeChargeSession(db, userId, vin, openCharge, end, summary)
  const openDrive = await openSession(db, driveSession, vin, userId)
  if (openDrive) await closeDriveSession(db, userId, vin, openDrive, end, summary)
}

// ── stale-session reaper ─────────────────────────────────────────────────────
// If the car goes offline mid-charge/mid-drive, the closing observation may never
// arrive. Close any open session whose last activity is older than the threshold
// so it can't stay open forever and swallow the next genuine session.
export async function reapStaleSessions(
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
export async function updateChargeSession(
  db: Db,
  userId: string,
  vin: string,
  snap: SnapshotInput,
  summary: PollSummary,
  debounceClose = false,
): Promise<void> {
  const recordedAt = snap.recordedAt
  const isCharging = snap.charging_state === 'Charging'
  const open = await openSession(db, chargeSession, vin, userId)

  if (isCharging && !open) {
    const source =
      (snap.charger_power ?? 0) >= SUPERCHARGER_KW_THRESHOLD ? 'supercharger' : 'home'
    try {
      await db.insert(chargeSession).values({
        vin,
        user_id: userId,
        source,
        started_at: recordedAt,
        lat: snap.latitude ?? null,
        lng: snap.longitude ?? null,
        energy_added_kwh: snap.charge_energy_added ?? 0,
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
    const incoming = snap.charge_energy_added ?? 0
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
    // Debounce (burst path only): a single not-Charging reading at the tight cadence
    // may be a charger blip ('Stopped'/'NoPower' that resumes) — wait for a second
    // consecutive inactive reading. BUT if the car is now DRIVING this is a real
    // charge→drive handoff, not a blip: close immediately so the charge doesn't
    // overlap the about-to-open drive session.
    const driving =
      snap.shift_state === 'D' || snap.shift_state === 'R' || snap.shift_state === 'N'
    if (debounceClose && !driving && (await priorWasActive(db, vin, userId, recordedAt, 'charge'))) return
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
  let energyKwh = agg.energyAdded ?? open.energy_added_kwh ?? 0
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
    .select({ free_supercharging: vehicle.free_supercharging, pack_kwh: vehicle.pack_kwh })
    .from(vehicle)
    .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
    .limit(1)

  // Physical backstop: a single charge session can't add more than the pack holds
  // (0→100%). If a counter glitch or a merged multi-charge window still produced
  // more, clamp so cost can't run away. The detection fix above is the real cure.
  if (veh?.pack_kwh != null && veh.pack_kwh > 0 && energyKwh > veh.pack_kwh) {
    summary.errors.push(`charge energy ${energyKwh.toFixed(1)} kWh > pack ${veh.pack_kwh} for ${vin}; clamped`)
    energyKwh = veh.pack_kwh
  }

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
      ? {
          flat_rate: rate.flat_rate,
          loss_factor: rate.loss_factor,
          currency: rate.currency,
          tou: parseTouSchedule(rate.tou_schedule),
        }
      : null,
    isHome: treatAsHome,
    startedAt: open.started_at,
    endedAt,
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
      // Guard against a double-close (DO close racing the cron's stale reaper):
      // only the writer that sees it still open wins; the loser updates 0 rows.
      .where(and(eq(chargeSession.id, open.id), isNull(chargeSession.ended_at)))
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
export async function updateDriveSession(
  db: Db,
  userId: string,
  vin: string,
  snap: SnapshotInput,
  summary: PollSummary,
  debounceClose = false,
): Promise<void> {
  const recordedAt = snap.recordedAt
  const driving =
    snap.shift_state === 'D' || snap.shift_state === 'R' || snap.shift_state === 'N'
  const open = await openSession(db, driveSession, vin, userId)

  if (driving && !open) {
    try {
      await db.insert(driveSession).values({
        vin,
        user_id: userId,
        started_at: recordedAt,
        start_odometer: snap.odometer ?? null,
        start_lat: snap.latitude ?? null,
        start_lng: snap.longitude ?? null,
        start_battery_level: snap.battery_level ?? null,
      })
    } catch (e) {
      if (!isUniqueViolation(e)) {
        throw new Error(`open drive session ${vin}: ${(e as Error).message}`)
      }
    }
    return
  }
  if (!driving && open) {
    // Debounce (burst path only): one not-driving reading at the tight cadence may
    // be a transient shift_state glitch — wait for a second consecutive inactive
    // reading. BUT if the car is now CHARGING this is a real drive→charge handoff,
    // not a blip: close immediately so the drive doesn't overlap the just-opened
    // charge session.
    const isCharging = (snap.charging_state ?? null) === 'Charging'
    if (debounceClose && !isCharging && (await priorWasActive(db, vin, userId, recordedAt, 'drive'))) return
    await closeDriveSession(db, userId, vin, open, recordedAt, summary)
  }
}

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
      // Guard against a double-close (DO close racing the cron's stale reaper):
      // only the writer that sees it still open wins; the loser updates 0 rows.
      .where(and(eq(driveSession.id, open.id), isNull(driveSession.ended_at)))
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
export async function insertAnomaly(
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
/** Does this vehicle have an open (un-ended) drive or charge session right now? */
export async function hasOpenSession(db: Db, userId: string, vin: string): Promise<boolean> {
  if (await openSession(db, chargeSession, vin, userId)) return true
  return (await openSession(db, driveSession, vin, userId)) != null
}

export async function openSession(
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

/**
 * Was the snapshot immediately BEFORE `beforeISO` still active for `kind`
 * (driving / charging)? Drives the burst-path close debounce: we only close a
 * session once inactivity is confirmed across two consecutive readings, so a
 * transient shift_state / charging_state blip at the ~20s cadence can't split one
 * session into many. No prior snapshot → treat as not-active (allow the close).
 */
export async function priorWasActive(
  db: Db,
  vin: string,
  userId: string,
  beforeISO: string,
  kind: 'drive' | 'charge',
): Promise<boolean> {
  const [p] = await db
    .select({ shift: vehicleSnapshot.shift_state, charging: vehicleSnapshot.charging_state })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.vin, vin),
        eq(vehicleSnapshot.user_id, userId),
        lt(vehicleSnapshot.recorded_at, beforeISO),
      ),
    )
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(1)
  if (!p) return false
  return kind === 'drive'
    ? p.shift === 'D' || p.shift === 'R' || p.shift === 'N'
    : p.charging === 'Charging'
}

export async function aggregateSnapshots(
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

  // charge_energy_added resets toward 0 at each physical charge start and rises
  // monotonically; sum per-segment peaks across GENUINE resets (large fractional
  // drops), ignoring sample noise. See sumChargeEnergyAdded.
  const energyAdded = sumChargeEnergyAdded(energies)

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

export async function lastSnapshotTime(db: Db, vin: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ recorded_at: vehicleSnapshot.recorded_at })
    .from(vehicleSnapshot)
    .where(and(eq(vehicleSnapshot.vin, vin), eq(vehicleSnapshot.user_id, userId)))
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(1)
  return rows[0]?.recorded_at ?? null
}

/**
 * The recorded_at of the most recent ACTIVE snapshot (driving or charging) for a
 * vehicle, or null. Used by the cron's idle-backoff to keep an actively-used car
 * on the fast cadence (the "recently active" grace window). One indexed query on
 * vehicle_snapshot_vin_time_idx.
 */
export async function lastActiveSnapshotTime(
  db: Db,
  vin: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      recorded_at: vehicleSnapshot.recorded_at,
      shift: vehicleSnapshot.shift_state,
      charging: vehicleSnapshot.charging_state,
    })
    .from(vehicleSnapshot)
    .where(and(eq(vehicleSnapshot.vin, vin), eq(vehicleSnapshot.user_id, userId)))
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(50)
  for (const r of rows) {
    const driving = r.shift === 'D' || r.shift === 'R' || r.shift === 'N'
    const charging = r.charging === 'Charging'
    if (driving || charging) return r.recorded_at
  }
  return null
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
export async function recordStateTransition(
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
export async function recordSoftwareUpdate(
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

export async function getRate(db: Db, userId: string): Promise<ElectricityRate | null> {
  const rows = await db
    .select()
    .from(electricityRate)
    .where(eq(electricityRate.user_id, userId))
    .limit(1)
  return (rows[0] as ElectricityRate) ?? null
}
