/**
 * Charging-location frequency — "your top charging locations" with visit count,
 * energy, cost, and avg charge speed per location. Reads only Postgres; groups at
 * query time (no geocoding, no new tables). Avg kW is derived from the
 * vehicle_snapshot charger_power readings that fall inside each session window.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gt, gte, isNotNull, lte } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { vinFilter } from './vin'
import { haversineMeters } from '../server/geo'
import { chargeSession, electricityRate, vehicleSnapshot } from '../server/schema'
import { locationKey } from '../lib/charge-location'
import type { ChargeSession, ElectricityRate } from '../types/db'

export interface ChargingLocation {
  key: string
  label: string
  source: string
  visitCount: number
  totalEnergyKwh: number
  avgEnergyKwh: number
  totalCost: number
  currency: string | null
  avgCostPerKwh: number | null
  avgChargeSpeedKw: number | null
  lat: number | null
  lng: number | null
  lastChargedAt: string | null
}

export interface ChargingLocationsPayload {
  locations: ChargingLocation[]
}

const MAX_SESSIONS = 2000
const MAX_SNAPSHOTS = 50000
const DEFAULT_HOME_RADIUS_M = 150

interface Acc {
  key: string
  source: string
  location_name: string | null
  lat: number | null
  lng: number | null
  visitCount: number
  totalEnergyKwh: number
  costEnergyKwh: number
  totalCost: number
  currency: string | null
  powerSum: number
  powerCount: number
  lastChargedAt: string | null
}

export const getChargingLocations = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<ChargingLocationsPayload> => {
    const db = getDb()
    const userId = context.userId
    const vin = data?.vin

    const sessions = (await db
      .select()
      .from(chargeSession)
      .where(
        and(
          eq(chargeSession.user_id, userId),
          isNotNull(chargeSession.ended_at),
          vin ? eq(chargeSession.vin, vin) : undefined,
        ),
      )
      .orderBy(asc(chargeSession.started_at))
      .limit(MAX_SESSIONS)) as ChargeSession[]

    if (!sessions.length) return { locations: [] }

    const rateRows = await db
      .select()
      .from(electricityRate)
      .where(eq(electricityRate.user_id, userId))
      .limit(1)
    const rate = (rateRows[0] as ElectricityRate | undefined) ?? null

    // ── avg charge speed: assign snapshot power readings to session windows ──
    const spanStart = sessions[0].started_at
    const spanEnd = sessions.reduce(
      (max, s) => (s.ended_at && s.ended_at > max ? s.ended_at : max),
      sessions[0].ended_at ?? sessions[0].started_at,
    )
    const snaps = await db
      .select({
        vin: vehicleSnapshot.vin,
        recorded_at: vehicleSnapshot.recorded_at,
        charger_power: vehicleSnapshot.charger_power,
      })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          gt(vehicleSnapshot.charger_power, 0),
          gte(vehicleSnapshot.recorded_at, spanStart),
          lte(vehicleSnapshot.recorded_at, spanEnd),
          vin ? eq(vehicleSnapshot.vin, vin) : undefined,
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))
      .limit(MAX_SNAPSHOTS)

    // Per-vin sorted windows for binary-search assignment.
    const windowsByVin = new Map<
      string,
      { startMs: number; endMs: number; key: string }[]
    >()
    for (const s of sessions) {
      if (!s.ended_at) continue
      const key = locationKey(s)
      const arr = windowsByVin.get(s.vin) ?? []
      arr.push({
        startMs: new Date(s.started_at).getTime(),
        endMs: new Date(s.ended_at).getTime(),
        key,
      })
      windowsByVin.set(s.vin, arr)
    }

    const powerByKey = new Map<string, { sum: number; count: number }>()
    for (const snap of snaps) {
      if (snap.charger_power == null) continue
      const windows = windowsByVin.get(snap.vin)
      if (!windows) continue
      const t = new Date(snap.recorded_at).getTime()
      const w = findWindow(windows, t)
      if (!w) continue
      const cur = powerByKey.get(w.key) ?? { sum: 0, count: 0 }
      cur.sum += snap.charger_power
      cur.count += 1
      powerByKey.set(w.key, cur)
    }

    // ── group sessions ──
    const groups = new Map<string, Acc>()
    for (const s of sessions) {
      const key = locationKey(s)
      const acc =
        groups.get(key) ??
        ({
          key,
          source: s.source,
          location_name: s.location_name,
          lat: s.lat,
          lng: s.lng,
          visitCount: 0,
          totalEnergyKwh: 0,
          costEnergyKwh: 0,
          totalCost: 0,
          currency: null,
          powerSum: 0,
          powerCount: 0,
          lastChargedAt: null,
        } as Acc)
      acc.visitCount += 1
      const energy = s.energy_added_kwh ?? 0
      acc.totalEnergyKwh += energy
      if (s.cost_amount != null) {
        acc.totalCost += s.cost_amount
        acc.costEnergyKwh += energy
        if (s.cost_currency) acc.currency = s.cost_currency
      }
      if (acc.location_name == null && s.location_name) acc.location_name = s.location_name
      if (acc.lat == null && s.lat != null) {
        acc.lat = s.lat
        acc.lng = s.lng
      }
      if (s.started_at && (acc.lastChargedAt == null || s.started_at > acc.lastChargedAt)) {
        acc.lastChargedAt = s.started_at
      }
      groups.set(key, acc)
    }

    // ── labels: SC name; Home (geofenced or inferred); else rounded coords ──
    const geoGroups = [...groups.values()].filter((g) => g.key.startsWith('geo:'))
    let homeKey: string | null = null
    if (rate?.home_lat != null && rate?.home_lng != null) {
      const radius = rate.home_radius_m ?? DEFAULT_HOME_RADIUS_M
      let best: { key: string; d: number } | null = null
      for (const g of geoGroups) {
        if (g.lat == null || g.lng == null) continue
        const d = haversineMeters(g.lat, g.lng, rate.home_lat, rate.home_lng)
        if (d <= radius && (!best || d < best.d)) best = { key: g.key, d }
      }
      homeKey = best?.key ?? null
    } else if (geoGroups.length) {
      // No configured home → infer the most-visited home/AC cluster.
      homeKey = geoGroups.reduce((a, b) => (b.visitCount > a.visitCount ? b : a)).key
    }

    const locations: ChargingLocation[] = [...groups.values()].map((g) => {
      const power = powerByKey.get(g.key)
      return {
        key: g.key,
        label: labelFor(g, homeKey),
        source: g.source,
        visitCount: g.visitCount,
        totalEnergyKwh: round(g.totalEnergyKwh),
        avgEnergyKwh: round(g.totalEnergyKwh / g.visitCount),
        totalCost: round(g.totalCost),
        currency: g.currency,
        avgCostPerKwh: g.costEnergyKwh > 0 ? round(g.totalCost / g.costEnergyKwh, 4) : null,
        avgChargeSpeedKw: power && power.count > 0 ? round(power.sum / power.count, 1) : null,
        lat: g.lat,
        lng: g.lng,
        lastChargedAt: g.lastChargedAt,
      }
    })

    locations.sort((a, b) => b.visitCount - a.visitCount || b.totalEnergyKwh - a.totalEnergyKwh)
    return { locations }
  })

function labelFor(g: Acc, homeKey: string | null): string {
  if (g.key === 'sc:unknown') return 'Supercharger (unknown site)'
  if (g.source === 'supercharger') return g.location_name ?? 'Supercharger'
  if (g.key === homeKey) return 'Home'
  if (g.key === 'unknown') return 'Unknown location'
  if (g.lat != null && g.lng != null) {
    return `${g.lat.toFixed(3)}, ${g.lng.toFixed(3)}`
  }
  return 'Other'
}

/** Latest window whose [startMs,endMs] contains t (binary search on startMs). */
function findWindow(
  windows: { startMs: number; endMs: number; key: string }[],
  t: number,
): { key: string } | null {
  let lo = 0
  let hi = windows.length - 1
  let cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (windows[mid].startMs <= t) {
      cand = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  // Walk back over any overlapping windows to find one that also covers t.
  for (let i = cand; i >= 0 && i >= cand - 3; i--) {
    if (i < 0) break
    if (windows[i].startMs <= t && windows[i].endMs >= t) return { key: windows[i].key }
  }
  return null
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}
