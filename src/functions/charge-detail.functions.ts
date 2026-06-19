/**
 * Single-charge detail. Powers the dedicated charge page
 * (/dashboard/charging/$id): the aggregate charge row + resolved place name, the
 * per-sample telemetry the poller/import stored during the session (SOC, rated
 * range, charge power / amperage / voltage, cabin + outside temperature), a map
 * marker for the charge location, the odometer at the time of charging (derived
 * from the nearest preceding drive — charge_session has no odometer), and the
 * distance driven since the previous charge. Read-only; scoped to the user.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { address, chargeSession, geofence, vehicleSnapshot } from '../server/schema'
import { addressLabel } from '../server/geo'
import { downsampleSeries } from '../lib/drive-detail-vm'
import type { ChargeSession } from '../types/db'
import type { ChargeWithLocation } from './charging.functions'

/** One downsampled telemetry sample taken during the charge (canonical raw units). */
export interface ChargeSampleRaw {
  /** Elapsed minutes from the charge's start. */
  tMin: number
  /** State of charge (%). */
  soc: number | null
  /** Rated range (mi — as Tesla reports it). */
  rangeMi: number | null
  /** Charge power (kW). */
  powerKw: number | null
  /** Charger current (A). */
  currentA: number | null
  /** Charger voltage (V). */
  voltageV: number | null
  /** Cabin (interior) temperature (°C). */
  insideC: number | null
  /** Outside (exterior) temperature (°C). */
  outsideC: number | null
}

export interface ChargeDetailPayload {
  charge: ChargeWithLocation | null
  /** Per-sample telemetry within the charge window, ordered + downsampled. */
  samples: ChargeSampleRaw[]
  /** [lat, lng] of the charge location for the map marker, or null when unknown. */
  point: [number, number] | null
  /** Odometer at the charge (mi), from the nearest preceding drive; null if unknown. */
  odometerMi: number | null
  /** Distance driven since the previous charge ended (mi); null if not derivable. */
  sinceLastChargeMi: number | null
}

/** Cap the per-sample payload so a long imported charge can't ship thousands of rows. */
const MAX_SAMPLES = 360

export const getChargeSessionDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ sessionId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<ChargeDetailPayload> =>
    withDb((db) => getChargeSessionDetailCore(db, context.userId, data.sessionId)),
  )

export async function getChargeSessionDetailCore(
  db: Db,
  userId: string,
  sessionId: number,
): Promise<ChargeDetailPayload> {
  const rows = await db
    .select()
    .from(chargeSession)
    .where(and(eq(chargeSession.id, sessionId), eq(chargeSession.user_id, userId)))
    .limit(1)
  const charge = rows[0] as ChargeSession | undefined
  if (!charge) return { charge: null, samples: [], point: null, odometerMi: null, sinceLastChargeMi: null }

  // Resolve the place name (named geofence wins over reverse-geocoded address,
  // then any stored location_name) — mirrors getChargingCore. Scoped to the user.
  const addrIds = [...new Set([charge.address_id].filter((x): x is number => x != null))]
  const geoIds = [...new Set([charge.geofence_id].filter((x): x is number => x != null))]
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
  const addr = addrRows[0]
  const geoName = geoRows[0]?.name
  const chargeWithLoc: ChargeWithLocation = {
    ...charge,
    locationName: geoName ?? (addr ? addressLabel(addr) : null) ?? charge.location_name ?? null,
  }

  // Telemetry stream for the charge window, oldest-first.
  const snaps = await db
    .select({
      at: vehicleSnapshot.recorded_at,
      batt: vehicleSnapshot.battery_level,
      ubatt: vehicleSnapshot.usable_battery_level,
      range: vehicleSnapshot.battery_range,
      pwr: vehicleSnapshot.power_kw,
      amp: vehicleSnapshot.charger_actual_current,
      volt: vehicleSnapshot.charger_voltage,
      inT: vehicleSnapshot.inside_temp,
      outT: vehicleSnapshot.outside_temp,
      lat: vehicleSnapshot.latitude,
      lng: vehicleSnapshot.longitude,
    })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        eq(vehicleSnapshot.vin, charge.vin),
        gte(vehicleSnapshot.recorded_at, charge.started_at),
        // For an open/in-progress charge (ended_at null) bound the window to now,
        // not started_at — else it collapses to a zero-width window and the live
        // telemetry the poller is writing wouldn't show.
        lte(vehicleSnapshot.recorded_at, charge.ended_at ?? new Date().toISOString()),
      ),
    )
    .orderBy(asc(vehicleSnapshot.recorded_at))

  const startMs = new Date(charge.started_at).getTime()
  const raw: ChargeSampleRaw[] = snaps.map((s) => ({
    tMin: Math.max(0, (new Date(s.at).getTime() - startMs) / 60000),
    soc: s.batt ?? s.ubatt ?? null,
    rangeMi: s.range ?? null,
    powerKw: s.pwr ?? null,
    currentA: s.amp ?? null,
    voltageV: s.volt ?? null,
    insideC: s.inT ?? null,
    outsideC: s.outT ?? null,
  }))
  const samples = downsampleSeries(raw, MAX_SAMPLES)

  // Map marker: the charge's own coordinate, else the first GPS-bearing sample.
  let point: [number, number] | null =
    charge.lat != null && charge.lng != null ? [charge.lat, charge.lng] : null
  if (!point) {
    const fix = snaps.find((s) => s.lat != null && s.lng != null)
    if (fix) point = [fix.lat as number, fix.lng as number]
  }

  // Odometer at a given instant = the nearest vehicle_snapshot odometer at/before it
  // (charge_session has no odometer column; snapshots are recorded every poll, even
  // while parked/charging, so they're far denser than drive ends). We also return
  // the reading's timestamp: if the nearest reading is far from the charge there was
  // a telemetry GAP and the odometer at that charge is genuinely unknown — don't
  // pretend to know it. Same shared db handle, indexed lookups.
  const odoAt = async (iso: string): Promise<{ odo: number; at: string } | null> => {
    const r = await db
      .select({ odo: vehicleSnapshot.odometer, at: vehicleSnapshot.recorded_at })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, charge.vin),
          isNotNull(vehicleSnapshot.odometer),
          lte(vehicleSnapshot.recorded_at, iso),
        ),
      )
      .orderBy(desc(vehicleSnapshot.recorded_at))
      .limit(1)
    return r[0]?.odo != null ? { odo: r[0].odo, at: r[0].at } : null
  }
  // A reading more than a day from the charge means polling/data wasn't running
  // then — the odometer is stale, so treat it as unknown rather than wrong.
  const STALE_MS = 24 * 60 * 60 * 1000
  const fresh = (ref: { at: string } | null, iso: string): boolean =>
    ref != null && Math.abs(new Date(iso).getTime() - new Date(ref.at).getTime()) <= STALE_MS

  const startRef = await odoAt(charge.started_at)
  const odometerMi = fresh(startRef, charge.started_at) ? startRef!.odo : null

  // "Since last charge": odometer at this charge minus the odometer at the previous
  // charge. Only when BOTH readings are fresh — else a telemetry gap near either
  // charge would inflate the distance with mileage that wasn't actually between them.
  let sinceLastChargeMi: number | null = null
  if (startRef != null && fresh(startRef, charge.started_at)) {
    const prev = await db
      .select({ ended_at: chargeSession.ended_at, started_at: chargeSession.started_at })
      .from(chargeSession)
      .where(
        and(
          eq(chargeSession.user_id, userId),
          eq(chargeSession.vin, charge.vin),
          lt(chargeSession.started_at, charge.started_at),
        ),
      )
      .orderBy(desc(chargeSession.started_at))
      .limit(1)
    const prevTime = prev[0]?.ended_at ?? prev[0]?.started_at ?? null
    if (prevTime != null) {
      const prevRef = await odoAt(prevTime)
      if (fresh(prevRef, prevTime)) sinceLastChargeMi = Math.max(0, startRef.odo - prevRef!.odo)
    }
  }

  return { charge: chargeWithLoc, samples, point, odometerMi, sinceLastChargeMi }
}
