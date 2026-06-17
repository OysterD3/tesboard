/**
 * Charging data for the dashboard. Reads only from Postgres (never the car).
 * RLS via the user-scoped client confines rows to the signed-in user.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vinFilter, type VinFilter } from './vin'
import { address, chargeSession, geofence, vehicleSnapshot } from '../server/schema'
import { addressLabel } from '../server/geo'
import type { ChargeSession } from '../types/db'

/** A charge row augmented with a resolved place name (geofence > address > stored name). */
export type ChargeWithLocation = ChargeSession & { locationName: string | null }

export interface ChargingStats {
  sessionCount: number
  totalEnergyKwh: number
  totalCost: number
  currency: string | null
  superchargerCost: number
  homeCost: number
  totalMilesAdded: number
  avgCostPerKwh: number | null
  avgCostPerMile: number | null
}

export interface ChargingPayload {
  sessions: ChargeWithLocation[]
  stats: ChargingStats
}

export const getCharging = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<ChargingPayload> =>
    withDb((db) => getChargingCore(db, context.userId, data)),
  )

export async function getChargingCore(
  db: Db,
  userId: string,
  data: VinFilter,
): Promise<ChargingPayload> {
    const vin = data?.vin
    const rows = await db
      .select()
      .from(chargeSession)
      .where(
        and(
          eq(chargeSession.user_id, userId),
          vin ? eq(chargeSession.vin, vin) : undefined,
        ),
      )
      .orderBy(desc(chargeSession.started_at))
      .limit(500)

    const baseSessions = rows as ChargeSession[]

    // Resolve a place name per session: a named geofence (Home, Work) wins, then the
    // reverse-geocoded address, then any stored location_name. Batched + user-scoped.
    const addrIds = [...new Set(baseSessions.map((s) => s.address_id).filter((x): x is number => x != null))]
    const geoIds = [...new Set(baseSessions.map((s) => s.geofence_id).filter((x): x is number => x != null))]

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

    const addrMap = new Map(addrRows.map((a) => [a.id, a]))
    const geoMap = new Map(geoRows.map((g) => [g.id, g.name]))

    const sessions: ChargeWithLocation[] = baseSessions.map((s) => {
      const geoName = s.geofence_id != null ? geoMap.get(s.geofence_id) : undefined
      const addr = s.address_id != null ? addrMap.get(s.address_id) : undefined
      return {
        ...s,
        locationName: geoName ?? (addr ? addressLabel(addr) : null) ?? s.location_name ?? null,
      }
    })

    const stats = summarize(sessions)
    return { sessions, stats }
}

function summarize(sessions: ChargeSession[]): ChargingStats {
  let totalEnergyKwh = 0
  let totalCost = 0
  let superchargerCost = 0
  let homeCost = 0
  let totalMilesAdded = 0
  let currency: string | null = null

  for (const s of sessions) {
    totalEnergyKwh += s.energy_added_kwh ?? 0
    totalMilesAdded += s.miles_added_rated ?? 0
    const cost = s.cost_amount ?? 0
    totalCost += cost
    if (s.cost_currency) currency = s.cost_currency
    if (s.source === 'supercharger') superchargerCost += cost
    else homeCost += cost
  }

  return {
    sessionCount: sessions.length,
    totalEnergyKwh: round(totalEnergyKwh),
    totalCost: round(totalCost),
    currency,
    superchargerCost: round(superchargerCost),
    homeCost: round(homeCost),
    totalMilesAdded: round(totalMilesAdded),
    avgCostPerKwh: totalEnergyKwh > 0 ? round(totalCost / totalEnergyKwh, 4) : null,
    avgCostPerMile: totalMilesAdded > 0 ? round(totalCost / totalMilesAdded, 4) : null,
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export interface ChargeDetail {
  /** Whether any per-snapshot power/SOC was captured during the session. */
  hasData: boolean
  /** Smoothed kW readings over the session window (charger_power per snapshot, median-filtered). */
  curve: number[]
  /**
   * Fractional position (0–1) of the taper onset along the curve, or null when
   * there is no genuine sustained drop from peak (e.g. flat AC charging). The UI
   * only draws the taper marker when this is non-null.
   */
  taperFrac: number | null
  peakKw: number | null
  soc0: number | null
  soc1: number | null
  /** Minutes from start when SOC first reached 80% / 100% (null if never). */
  hit80: number | null
  hit100: number | null
  /** Minutes spent at ≥80% while still plugged in. */
  minAbove80: number
}

/**
 * Reconstruct a charge session's power curve, peak, SOC range and 80/100% timing
 * from the `vehicle_snapshot` rows captured during it (charger_power + battery_level).
 * The Fleet API gives no per-session curve, so this is the real sampled telemetry
 * at the poll cadence. Scoped to the user's rows.
 */
export const getChargeDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ sessionId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<ChargeDetail> =>
    withDb(async (db) => {
    const userId = context.userId
    const empty: ChargeDetail = { hasData: false, curve: [], taperFrac: null, peakKw: null, soc0: null, soc1: null, hit80: null, hit100: null, minAbove80: 0 }

    const rows = await db
      .select()
      .from(chargeSession)
      .where(and(eq(chargeSession.id, data.sessionId), eq(chargeSession.user_id, userId)))
      .limit(1)
    const session = rows[0] as ChargeSession | undefined
    if (!session) return empty

    const snaps = await db
      .select({
        power: vehicleSnapshot.charger_power,
        soc: vehicleSnapshot.battery_level,
        at: vehicleSnapshot.recorded_at,
      })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, session.vin),
          gte(vehicleSnapshot.recorded_at, session.started_at),
          lte(vehicleSnapshot.recorded_at, session.ended_at ?? new Date().toISOString()),
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))
    if (snaps.length === 0) return empty

    const startMs = new Date(session.started_at).getTime()
    const minutesAt = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - startMs) / 60000))

    const powers = snaps.map((s) => s.power).filter((p): p is number => p != null && p >= 0)
    const socs = snaps.map((s) => s.soc).filter((s): s is number => s != null)

    let hit80: number | null = null
    let hit100: number | null = null
    let firstAbove80At: number | null = null
    let lastAt = minutesAt(session.ended_at ?? session.started_at)
    for (const s of snaps) {
      const m = minutesAt(s.at)
      lastAt = Math.max(lastAt, m)
      if (s.soc != null) {
        if (hit80 == null && s.soc >= 80) hit80 = m
        if (hit100 == null && s.soc >= 100) hit100 = m
        if (firstAbove80At == null && s.soc >= 80) firstAbove80At = m
      }
    }
    const minAbove80 = firstAbove80At != null ? Math.max(0, lastAt - firstAbove80At) : 0

    // `charger_power` is a rounded integer that twitches sample-to-sample (e.g. an AC
    // charge sitting at 11 kW logs occasional 1/5/8 kW dips). A median filter removes
    // those single-sample impulses while preserving real edges (peaks + genuine tapers).
    const curve = downsample(medianSmooth(powers, 5), 80)

    return {
      hasData: powers.length > 0 || socs.length > 0,
      curve,
      taperFrac: detectTaper(curve),
      peakKw: powers.length ? round(Math.max(...powers), 1) : null,
      soc0: socs.length ? socs[0] : null,
      soc1: socs.length ? socs[socs.length - 1] : null,
      hit80,
      hit100,
      minAbove80,
    }
  }))

/** Evenly sample down to at most `max` points so the chart path stays light. */
function downsample(arr: number[], max: number): number[] {
  if (arr.length <= max) return arr
  const step = arr.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)])
  return out
}

/** Windowed median — kills isolated sample spikes while keeping real edges. */
function medianSmooth(arr: number[], win: number): number[] {
  if (arr.length < win || win < 2) return arr
  const half = Math.floor(win / 2)
  const out: number[] = []
  for (let i = 0; i < arr.length; i++) {
    const w = arr.slice(Math.max(0, i - half), Math.min(arr.length, i + half + 1)).sort((a, b) => a - b)
    out.push(w[Math.floor(w.length / 2)])
  }
  return out
}

/**
 * Locate the taper onset on a (smoothed) power curve, or null when there isn't one.
 * A genuine taper (DC fast-charge) plateaus near peak then drops and stays low; flat
 * AC charging holds near peak to the end, so we return null and the UI hides the marker.
 * Returns the fractional position (0–1) where power last falls below 85% of peak and
 * never recovers — only when the tail ends meaningfully below peak and isn't the whole curve.
 */
function detectTaper(curve: number[]): number | null {
  const n = curve.length
  if (n < 8) return null
  const peak = Math.max(...curve)
  if (peak <= 0) return null
  // Still near peak at the end ⇒ no taper (flat AC).
  if (curve[n - 1] > peak * 0.8) return null
  const thresh = peak * 0.85
  // Walk back over the contiguous below-threshold tail to find its onset.
  let onset = n - 1
  for (let i = n - 1; i >= 0; i--) {
    if (curve[i] <= thresh) onset = i
    else break
  }
  // Require a real plateau before the taper (not a curve that only ever declines).
  if (onset <= n * 0.15) return null
  return onset / (n - 1)
}
