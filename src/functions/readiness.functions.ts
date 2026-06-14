/**
 * Departure readiness — "should I plug in tonight?" at a glance, from the LAST
 * stored snapshot. Reads only Postgres; never calls Tesla, never wakes the car.
 * A sleeping car yields no new snapshot, so the reading can legitimately be hours
 * old — staleness is computed and surfaced honestly.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { electricityRate, vehicle, vehicleSnapshot } from '../server/schema'
import type { ChargingState, Vehicle, VehicleSnapshot } from '../types/db'

export type Staleness = 'fresh' | 'recent' | 'stale' | 'very_stale' | 'none'
export type ReadinessRecommendation = 'charging' | 'ok' | 'consider_charging' | 'unknown'

export interface DepartureReadiness {
  vin: string
  display_name: string | null
  soc_pct: number | null
  est_range_mi: number | null
  charging_state: ChargingState | null
  is_charging: boolean
  as_of: string | null
  age_seconds: number | null
  staleness: Staleness
  target_soc: number
  recommendation: ReadinessRecommendation
}

export interface DepartureReadinessPayload {
  vehicles: DepartureReadiness[]
}

const DEFAULT_TARGET_SOC = 80
const FRESH_S = 10 * 60
const RECENT_S = 2 * 60 * 60
const STALE_S = 12 * 60 * 60

function staleness(ageSeconds: number | null): Staleness {
  if (ageSeconds == null) return 'none'
  if (ageSeconds < FRESH_S) return 'fresh'
  if (ageSeconds < RECENT_S) return 'recent'
  if (ageSeconds < STALE_S) return 'stale'
  return 'very_stale'
}

export const getDepartureReadiness = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<DepartureReadinessPayload> => {
    const db = getDb()
    const userId = context.userId

    const [rateRows, vehicles] = await Promise.all([
      db
        .select({ target: electricityRate.departure_target_soc })
        .from(electricityRate)
        .where(eq(electricityRate.user_id, userId))
        .limit(1),
      db.select().from(vehicle).where(eq(vehicle.user_id, userId)).orderBy(vehicle.created_at),
    ])
    const targetSoc = rateRows[0]?.target ?? DEFAULT_TARGET_SOC

    const now = Date.now()
    const out: DepartureReadiness[] = []
    for (const v of vehicles as Vehicle[]) {
      const snap = await db
        .select()
        .from(vehicleSnapshot)
        .where(and(eq(vehicleSnapshot.user_id, userId), eq(vehicleSnapshot.vin, v.vin)))
        .orderBy(desc(vehicleSnapshot.recorded_at))
        .limit(1)
      const latest = (snap[0] as VehicleSnapshot | undefined) ?? null

      const soc = latest ? (latest.usable_battery_level ?? latest.battery_level) : null
      const range = latest ? (latest.est_battery_range ?? latest.battery_range) : null
      const asOf = latest?.recorded_at ?? null
      const ageSeconds = asOf ? Math.max(0, Math.round((now - new Date(asOf).getTime()) / 1000)) : null
      const isCharging = latest?.charging_state === 'Charging'
      const bucket = staleness(ageSeconds)

      let recommendation: ReadinessRecommendation
      if (isCharging) recommendation = 'charging'
      else if (soc == null || bucket === 'very_stale' || bucket === 'none') recommendation = 'unknown'
      else recommendation = soc >= targetSoc ? 'ok' : 'consider_charging'

      out.push({
        vin: v.vin,
        display_name: v.display_name,
        soc_pct: soc,
        est_range_mi: range,
        charging_state: latest?.charging_state ?? null,
        is_charging: isCharging,
        as_of: asOf,
        age_seconds: ageSeconds,
        staleness: bucket,
        target_soc: targetSoc,
        recommendation,
      })
    }

    return { vehicles: out }
  })
