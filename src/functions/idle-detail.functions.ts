/**
 * Single-idle detail. Powers the dedicated idle page (/dashboard/idles/$id).
 *
 * There is no "idle" table — an idle is the *parked gap* between two drives. We
 * identify it by the PRECEDING drive's id (`prevDriveId`): the idle is the time
 * the car sat still after that drive ended and before the next drive began. The
 * window is [prevDrive.ended_at, nextDrive.started_at]; the park location, SOC
 * and rated-range drift come from the bounding drives' end→start columns, the
 * battery/temp/charge-power series from the snapshots inside the window, the
 * asleep/online/offline split from the overlapping vehicle_state intervals, and
 * the charger energy/cost from any charge session overlapping the window.
 * Read-only; scoped to the user's rows.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { address, chargeSession, driveSession, geofence, vehicle, vehicleSnapshot, vehicleState } from '../server/schema'
import { addressLabel } from '../server/geo'
import { downsampleSeries } from '../lib/drive-detail-vm'
import { IDLE_MIN_GAP_S } from '../lib/idles-vm'
import type { DriveSession } from '../types/db'

/** One downsampled telemetry sample taken while parked (canonical raw units). */
export interface IdleSampleRaw {
  /** Elapsed minutes from the start of the parked window. */
  tMin: number
  /** State of charge (%). */
  soc: number | null
  /** Rated range (mi — as Tesla reports it). */
  rangeMi: number | null
  /** Cabin (interior) temperature (°C). */
  insideC: number | null
  /** Outside (exterior) temperature (°C). */
  outsideC: number | null
  /** Charger power (kW) — 0 while purely idle, > 0 if a charge ran during the park. */
  powerKw: number | null
}

/** A vehicle_state span overlapping the parked window (clipped in the VM). */
export interface IdleStateSpan {
  state: string
  started_at: string
  ended_at: string | null
}

export interface IdleDetailPayload {
  found: boolean
  prevDriveId: number
  vin: string | null
  /** Window start = the preceding drive's ended_at. */
  startedAt: string | null
  /** Window end = the next drive's started_at. */
  endedAt: string | null
  /** Park location name (the preceding drive's end place). */
  place: string | null
  /** [lat, lng] of the park location, or null when unknown. */
  point: [number, number] | null
  /** SOC at the park endpoints (prevDrive.end → nextDrive.start). */
  startBattery: number | null
  endBattery: number | null
  /** Rated range (mi) at the park endpoints. */
  startRangeMi: number | null
  endRangeMi: number | null
  /** Vehicle pack/efficiency for the energy math (canonical raw). */
  effWhPerMi: number | null
  packKwh: number | null
  /** Grid energy added by charges overlapping the window (kWh), summed. */
  chargerKwh: number | null
  /** Cost of overlapping charges (summed), or null. */
  cost: { amount: number; currency: string } | null
  /** vehicle_state spans overlapping the window (for asleep%/online%/offline%). */
  states: IdleStateSpan[]
  /** Per-sample telemetry within the window, ordered + downsampled. */
  samples: IdleSampleRaw[]
}

/** Cap the per-sample payload so a long parked window can't ship thousands of rows. */
const MAX_SAMPLES = 360
/**
 * Hard DB-read cap on in-window snapshots. Unlike a drive, a parked window is
 * unbounded (a car can sit for weeks), so cap the transfer before the in-memory
 * downsample. Generous enough that real windows are never truncated; a safety
 * valve against a pathologically long+dense (e.g. imported) window OOM-ing the
 * Worker. Oldest-first, so a capped window keeps the start of the park.
 */
const SNAPSHOT_READ_CAP = MAX_SAMPLES * 30

const EMPTY = (prevDriveId: number): IdleDetailPayload => ({
  found: false,
  prevDriveId,
  vin: null,
  startedAt: null,
  endedAt: null,
  place: null,
  point: null,
  startBattery: null,
  endBattery: null,
  startRangeMi: null,
  endRangeMi: null,
  effWhPerMi: null,
  packKwh: null,
  chargerKwh: null,
  cost: null,
  states: [],
  samples: [],
})

export const getIdleDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ prevDriveId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<IdleDetailPayload> =>
    withDb((db) => getIdleDetailCore(db, context.userId, data.prevDriveId)),
  )

export async function getIdleDetailCore(
  db: Db,
  userId: string,
  prevDriveId: number,
): Promise<IdleDetailPayload> {
  // The drive whose end opens the parked window.
  const prevRows = await db
    .select()
    .from(driveSession)
    .where(and(eq(driveSession.id, prevDriveId), eq(driveSession.user_id, userId)))
    .limit(1)
  const prev = prevRows[0] as DriveSession | undefined
  if (!prev || !prev.ended_at) return EMPTY(prevDriveId)

  // The chronologically next CLOSED drive for the same car bounds the window's
  // end. The closed-only filter mirrors the history list (which is built from
  // closed drives), so the detail window can't diverge from the card the user
  // tapped — e.g. by ending at an in-progress drive that the list never shows.
  const nextRows = await db
    .select()
    .from(driveSession)
    .where(
      and(
        eq(driveSession.user_id, userId),
        eq(driveSession.vin, prev.vin),
        isNotNull(driveSession.ended_at),
        gt(driveSession.started_at, prev.started_at),
      ),
    )
    .orderBy(asc(driveSession.started_at))
    .limit(1)
  const next = nextRows[0] as DriveSession | undefined
  if (!next) return EMPTY(prevDriveId)

  const startedAt = prev.ended_at
  const endedAt = next.started_at
  // Reject non-positive and sub-jitter-floor windows so the server fn agrees with
  // the list builder on what counts as an idle (else a card-less, direct-URL-only
  // idle could render).
  if ((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000 < IDLE_MIN_GAP_S)
    return EMPTY(prevDriveId)

  // Park location name: named geofence wins over reverse-geocoded address. Use the
  // preceding drive's end endpoint (where the car came to rest).
  const addrIds = [...new Set([prev.end_address_id].filter((x): x is number => x != null))]
  const geoIds = [...new Set([prev.end_geofence_id].filter((x): x is number => x != null))]
  const addrRows = addrIds.length
    ? await db
        .select({
          id: address.id,
          name: address.name,
          road: address.road,
          neighbourhood: address.neighbourhood,
          city: address.city,
          display_name: address.display_name,
        })
        .from(address)
        .where(and(eq(address.user_id, userId), inArray(address.id, addrIds)))
    : []
  const geoRows = geoIds.length
    ? await db
        .select({ id: geofence.id, name: geofence.name })
        .from(geofence)
        .where(and(eq(geofence.user_id, userId), inArray(geofence.id, geoIds)))
    : []
  const place =
    geoRows[0]?.name ?? (addrRows[0] ? addressLabel(addrRows[0]) : null)
  const point: [number, number] | null =
    prev.end_lat != null && prev.end_lng != null
      ? [prev.end_lat, prev.end_lng]
      : next.start_lat != null && next.start_lng != null
        ? [next.start_lat, next.start_lng]
        : null

  // Vehicle pack/efficiency for the energy math.
  const vehRows = await db
    .select({ pack_kwh: vehicle.pack_kwh, eff: vehicle.efficiency_wh_per_mi })
    .from(vehicle)
    .where(and(eq(vehicle.vin, prev.vin), eq(vehicle.user_id, userId)))
    .limit(1)
  const veh = vehRows[0]

  // Telemetry stream within the parked window, oldest-first.
  const snaps = await db
    .select({
      at: vehicleSnapshot.recorded_at,
      batt: vehicleSnapshot.battery_level,
      ubatt: vehicleSnapshot.usable_battery_level,
      range: vehicleSnapshot.battery_range,
      inT: vehicleSnapshot.inside_temp,
      outT: vehicleSnapshot.outside_temp,
      pwr: vehicleSnapshot.charger_power,
    })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        eq(vehicleSnapshot.vin, prev.vin),
        gte(vehicleSnapshot.recorded_at, startedAt),
        // Half-open upper bound (matches the state/charge overlap predicates): the
        // snapshot recorded at exactly endedAt is the next drive's opening fix, not
        // part of the park.
        lt(vehicleSnapshot.recorded_at, endedAt),
      ),
    )
    .orderBy(asc(vehicleSnapshot.recorded_at))
    .limit(SNAPSHOT_READ_CAP)

  const startMs = new Date(startedAt).getTime()
  const raw: IdleSampleRaw[] = snaps.map((s) => ({
    tMin: Math.max(0, (new Date(s.at).getTime() - startMs) / 60000),
    soc: s.batt ?? s.ubatt ?? null,
    rangeMi: s.range ?? null,
    insideC: s.inT ?? null,
    outsideC: s.outT ?? null,
    powerKw: s.pwr ?? null,
  }))
  const samples = downsampleSeries(raw, MAX_SAMPLES)

  // State spans overlapping [startedAt, endedAt]: started before the window ends
  // AND still open or ended after the window starts.
  const states = (await db
    .select({
      state: vehicleState.state,
      started_at: vehicleState.started_at,
      ended_at: vehicleState.ended_at,
    })
    .from(vehicleState)
    .where(
      and(
        eq(vehicleState.user_id, userId),
        eq(vehicleState.vin, prev.vin),
        lt(vehicleState.started_at, endedAt),
        or(isNull(vehicleState.ended_at), gt(vehicleState.ended_at, startedAt)),
      ),
    )
    .orderBy(asc(vehicleState.started_at))) as IdleStateSpan[]

  // Charge sessions overlapping the window → grid energy added + any billed cost.
  const charges = await db
    .select({
      energy: chargeSession.energy_added_kwh,
      cost: chargeSession.cost_amount,
      currency: chargeSession.cost_currency,
    })
    .from(chargeSession)
    .where(
      and(
        eq(chargeSession.user_id, userId),
        eq(chargeSession.vin, prev.vin),
        lt(chargeSession.started_at, endedAt),
        or(isNull(chargeSession.ended_at), gt(chargeSession.ended_at, startedAt)),
      ),
    )
  let chargerKwh: number | null = null
  let costAmount = 0
  let costCurrency: string | null = null
  for (const c of charges) {
    if (c.energy != null) chargerKwh = (chargerKwh ?? 0) + c.energy
    if (c.cost != null) {
      costAmount += c.cost
      costCurrency = costCurrency ?? c.currency ?? null
    }
  }
  const cost = costCurrency != null ? { amount: costAmount, currency: costCurrency } : null

  return {
    found: true,
    prevDriveId,
    vin: prev.vin,
    startedAt,
    endedAt,
    place,
    point,
    startBattery: prev.end_battery_level,
    endBattery: next.start_battery_level,
    startRangeMi: prev.end_range_mi,
    endRangeMi: next.start_range_mi,
    effWhPerMi: veh?.eff ?? null,
    packKwh: veh?.pack_kwh ?? null,
    chargerKwh,
    cost,
    states,
    samples,
  }
}
