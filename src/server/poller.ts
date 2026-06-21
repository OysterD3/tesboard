/**
 * Sleep-aware poller — the REST adapter over the runtime-agnostic sessionization
 * engine (./sessionize).
 *
 * One cycle: for each linked user → list vehicles (cheap) → reap stale open
 * sessions → if a vehicle is `online`, read vehicle_data once and append a
 * snapshot, then update open drive/charge sessions from the new snapshot. NEVER
 * calls wake_up; a sleeping car returns ASLEEP and we record state and back off.
 *
 * Runs under the Drizzle owner connection, so every write sets user_id and every
 * read is scoped by user_id explicitly (app-enforced row ownership).
 *
 * Dual-mode: when INGEST_MODE=telemetry the poll cron no-ops (the self-hosted
 * telemetry adapter ingests instead, reusing the same ./sessionize functions).
 * In polling mode, idle-backoff skips the billable vehicle_data read for cars
 * judged idle from cheap state (the big cost saver).
 */
import { and, eq } from 'drizzle-orm'
import { withDb, type Db } from './db'
import { serverEnv } from './env'
import { teslaAccount, vehicle } from './schema'
import {
  ASLEEP,
  createTeslaClient,
  getVehicleData,
  listVehicles,
  type ClientCtx,
} from './tesla/client.server'
import type { TeslaDriveState, TeslaVehicleData, TeslaVehicleListItem } from './tesla/types'
import type { PollMode } from '../lib/burst-vm'
import type { Json } from '../types/db'
import {
  emptyPollSummary,
  hasOpenSession,
  insertSnapshot,
  lastActiveSnapshotTime,
  lastSnapshotTime,
  reapStaleSessions,
  recordSoftwareUpdate,
  recordStateTransition,
  updateChargeSession,
  updateDriveSession,
  type PollSummary,
  type SnapshotInput,
} from './sessionize'

// Re-export the runtime-agnostic pieces that other server modules import from
// `./poller` (vehicle-poller.ts → closeOpenSessions, emptyPollSummary). Keeping
// these import paths green minimises churn.
export {
  closeOpenSessions,
  emptyPollSummary,
  type PollSummary,
} from './sessionize'

export interface ArmTarget {
  userId: string
  vin: string
}

export type PollCycleResult = PollSummary & { armVins: ArmTarget[] }

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

/**
 * Map a Tesla vehicle_data response into the flat, runtime-agnostic SnapshotInput
 * the sessionizer consumes. (This is the field-extraction body that used to live
 * inside insertSnapshot.)
 */
export function teslaDataToSnapshot(data: TeslaVehicleData, recordedAt: string): SnapshotInput {
  const cs = data.charge_state ?? {}
  const ds = data.drive_state ?? {}
  const vs = data.vehicle_state ?? {}
  const cl = data.climate_state ?? {}
  return {
    recordedAt,
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
    // No live vehicle_data field for these two — telemetry populates them.
    charger_actual_current: null,
    charger_phases: null,
    power_kw: ds.power ?? null,
    sentry_mode: vs.sentry_mode ?? null,
    is_climate_on: cl.is_climate_on ?? null,
    is_preconditioning: cl.is_preconditioning ?? null,
    gps_as_of: locationAsOf(ds),
    raw_json: data as unknown as Json,
    importSource: 'live',
  }
}

/**
 * One baseline poll cycle (the cron). When burst polling is ON, the cron stays
 * the baseline + watchdog: for an online car with an open session it defers to the
 * Durable Object (the sole writer, so dense polling can't split sessions); for an
 * online car with NO open session it polls once to detect a drive/charge START. It
 * returns the VINs that are active (or have an open session) for the worker to
 * arm/re-arm the per-VIN DO — so a merely parked-but-awake car never spins the DO.
 * When burst is OFF this behaves exactly as it always has — closing sessions
 * inline, no DO involved, `armVins` empty.
 *
 * In telemetry mode this is a no-op: zero vehicle_data calls, zero DO arming, zero
 * snapshot writes from CF — the self-hosted adapter ingests instead.
 */
export async function runPollCycle(): Promise<PollCycleResult> {
  if (serverEnv.ingestMode() === 'telemetry') {
    return { ...emptyPollSummary(), armVins: [] }
  }
  const burstEnabled = serverEnv.burstPoll().enabled
  return withDb(async (db) => {
    const summary = emptyPollSummary()
    const armVins: ArmTarget[] = []

    const accounts = await db.select({ user_id: teslaAccount.user_id }).from(teslaAccount)

    for (const acct of accounts) {
      summary.users++
      try {
        await pollUser(db, acct.user_id, summary, burstEnabled, armVins)
      } catch (e) {
        summary.errors.push(`user ${acct.user_id}: ${(e as Error).message}`)
      }
    }
    return { ...summary, armVins }
  })
}

async function pollUser(
  db: Db,
  userId: string,
  summary: PollSummary,
  burstEnabled: boolean,
  armVins: ArmTarget[],
): Promise<void> {
  const ctx = await createTeslaClient(db, userId)
  const vehicles = await listVehicles(ctx)

  for (const v of vehicles) {
    if (burstEnabled) {
      // Burst ON. Sleeping/offline cars never get a DO — cheap, sleep-safe
      // bookkeeping only (state timeline + the 6h stale-session reaper).
      if (v.state !== 'online') {
        await reapStaleSessions(db, userId, v.vin, summary)
        await setLastState(db, userId, v.vin, v.state, summary)
        await recordStateTransition(db, userId, v.vin, v.state, summary)
        summary.asleep++
        continue
      }

      // Online with an OPEN drive/charge session: the per-VIN DO owns it as the SOLE
      // writer. Re-arm it and DEFER — do NOT read vehicle_data here, so the cron
      // can't interleave a write and split the session. Keep state/timeline current.
      if (await hasOpenSession(db, userId, v.vin)) {
        await reapStaleSessions(db, userId, v.vin, summary)
        await setLastState(db, userId, v.vin, v.state, summary)
        await recordStateTransition(db, userId, v.vin, v.state, summary)
        armVins.push({ userId, vin: v.vin })
        continue
      }

      // Online but NO open session: the car is awake yet not mid-session — it may
      // just have started driving/charging, OR it's only parked-but-awake (Sentry /
      // climate). Idle-backoff (when enabled) skips the billable vehicle_data read
      // for an awake-but-parked car until the backoff interval elapses. Poll ONCE
      // here (the cron is the sole writer right now — the DO isn't running) and arm
      // the DO ONLY on an active reading. A parked-but-awake car therefore stays on
      // the cheap cron cadence instead of spinning the DO every ~20-30s.
      if (!(await shouldPollOnline(db, userId, v.vin, summary))) {
        // Skip the read; cheap bookkeeping already done in shouldPollOnline.
        continue
      }
      const mode = await pollVehicleStep(db, userId, ctx, v, summary, /* debounceClose */ false)
      if (mode === 'driving' || mode === 'charging') armVins.push({ userId, vin: v.vin })
      continue
    }

    // Burst OFF: the cron polls + sessionizes inline, closing on the first
    // not-active reading. Idle-backoff (when enabled) still skips the billable
    // read for an awake-but-parked car.
    if (v.state === 'online' && !(await hasOpenSession(db, userId, v.vin))) {
      if (!(await shouldPollOnline(db, userId, v.vin, summary))) continue
    }
    await pollVehicleStep(db, userId, ctx, v, summary, /* debounceClose */ false)
  }
}

/**
 * Idle-backoff decision for an ONLINE car with NO open session: should we spend a
 * billable vehicle_data read this cycle, or skip it? Reads cheap state only (the
 * last snapshot time + last ACTIVE snapshot time + cached last_state) — never
 * probes (a probe is itself billable). Does the cheap bookkeeping (reap, last_state,
 * state transition) REGARDLESS, exactly as the read path would, so a skipped cycle
 * still maintains the state timeline and reaper.
 *
 * Returns true (poll) when:
 *  - idle-backoff is disabled, OR
 *  - the backoff interval has elapsed since the last snapshot, OR
 *  - the car was recently active (within the grace window), OR
 *  - the car just woke (cached last_state was not 'online').
 */
async function shouldPollOnline(
  db: Db,
  userId: string,
  vin: string,
  summary: PollSummary,
): Promise<boolean> {
  const cfg = serverEnv.idleBackoff()
  if (!cfg.enabled) {
    // Backoff off — keep current behaviour: read every cycle. (The caller still
    // does reap/last_state/state-transition inside pollVehicleStep.)
    return true
  }

  // Read the cached prior state BEFORE we overwrite it, to detect a fresh wake.
  const [veh] = await db
    .select({ last_state: vehicle.last_state })
    .from(vehicle)
    .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
    .limit(1)
  const justWoke = (veh?.last_state ?? null) !== 'online'

  // Cheap bookkeeping happens whether or not we poll (mirrors pollVehicleStep's
  // leading steps), so a skipped cycle still keeps the state timeline + reaper live.
  await reapStaleSessions(db, userId, vin, summary)
  await setLastState(db, userId, vin, 'online', summary)
  await recordStateTransition(db, userId, vin, 'online', summary)

  if (justWoke) return true

  const now = Date.now()
  const lastSnap = await lastSnapshotTime(db, vin, userId)
  if (lastSnap == null) return true // never polled — read once to establish a baseline
  if (now - new Date(lastSnap).getTime() >= cfg.idleMin * 60_000) return true

  const lastActive = await lastActiveSnapshotTime(db, vin, userId)
  if (lastActive != null && now - new Date(lastActive).getTime() <= cfg.graceMin * 60_000) return true

  // Awake-but-parked, within the backoff interval, not recently active → skip the
  // billable read this cycle.
  return false
}

/** Update the cached last_state (best-effort; an error here never aborts a poll). */
async function setLastState(
  db: Db,
  userId: string,
  vin: string,
  state: string,
  summary: PollSummary,
): Promise<void> {
  try {
    await db
      .update(vehicle)
      .set({ last_state: state, updated_at: new Date().toISOString() })
      .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
  } catch (e) {
    summary.errors.push(`vehicle ${vin}: ${(e as Error).message}`)
  }
}

/**
 * Poll ONE vehicle once: reap stale sessions, track state, and (if online) read
 * vehicle_data, append a snapshot, and update its open drive/charge sessions.
 * Returns the poll outcome so the burst loop can decide its next move. Used by the
 * baseline cron (`debounceClose=false`, burst OFF) and by the per-VIN Durable
 * Object (`debounceClose=true` — at the tight cadence a session closes only after
 * two consecutive inactive readings, so a transient blip can't split it). When
 * burst is ON the cron does NOT call this for online cars — the DO is the sole
 * vehicle_data + session writer (see pollUser).
 */
export async function pollVehicleStep(
  db: Db,
  userId: string,
  ctx: ClientCtx,
  v: TeslaVehicleListItem,
  summary: PollSummary,
  debounceClose: boolean,
): Promise<PollMode> {
  await reapStaleSessions(db, userId, v.vin, summary)
  await setLastState(db, userId, v.vin, v.state, summary)

  // State-interval history (online/asleep/offline) — runs for every vehicle,
  // even sleeping ones (that's the point: a sleep timeline + drain attribution).
  await recordStateTransition(db, userId, v.vin, v.state, summary)

  if (v.state !== 'online') {
    summary.asleep++
    return v.state === 'asleep' ? 'asleep' : 'offline' // back off — do NOT wake the car
  }

  const data = await getVehicleData(ctx, String(v.id))
  if (data === ASLEEP) {
    summary.asleep++
    return 'asleep'
  }

  // Firmware version history (best-effort; never abort the cycle).
  await recordSoftwareUpdate(db, userId, v.vin, data.vehicle_state?.car_version ?? null, summary)

  const recordedAt = new Date().toISOString()
  const snap = teslaDataToSnapshot(data, recordedAt)
  const snapErr = await insertSnapshot(db, userId, v.vin, snap)
  if (snapErr) {
    // Don't sessionize from an incomplete snapshot set.
    summary.errors.push(`snapshot ${v.vin}: ${snapErr}`)
    return 'error'
  }
  summary.snapshots++
  summary.vehiclesPolled++

  await updateChargeSession(db, userId, v.vin, snap, summary, debounceClose)
  await updateDriveSession(db, userId, v.vin, snap, summary, debounceClose)

  const driving =
    snap.shift_state === 'D' || snap.shift_state === 'R' || snap.shift_state === 'N'
  if (driving) return 'driving'
  if (snap.charging_state === 'Charging') return 'charging'
  return 'idle'
}
