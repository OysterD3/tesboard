/**
 * Battery health / degradation + projected range. Derived entirely from data we
 * already capture (rated range + usable SOC at charge endpoints) × the per-vehicle
 * efficiency factor. Read-only; authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { chargeSession, vehicle } from '../server/schema'
import {
  buildBatteryHealth,
  capacityKwh,
  projectedRangeMi,
  type CapacityPoint,
} from '../lib/analytics-vm'
import { vinFilter, type VinFilter } from './vin'

export interface BatteryHealthResult {
  efficiencyWhPerMi: number | null
  currentKwh: number | null
  maxKwh: number | null
  degradationPct: number | null
  projectedRangeMi: number | null
  series: CapacityPoint[]
}

export const getBatteryHealth = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<BatteryHealthResult> =>
    withDb((db) => getBatteryHealthCore(db, context.userId, data)),
  )

export async function getBatteryHealthCore(
  db: Db,
  userId: string,
  data: VinFilter,
): Promise<BatteryHealthResult> {
    const vin = data?.vin
    const [veh] = await db
      .select({ eff: vehicle.efficiency_wh_per_mi })
      .from(vehicle)
      .where(and(eq(vehicle.user_id, userId), vin ? eq(vehicle.vin, vin) : undefined))
      .limit(1)
    const eff = veh?.eff ?? null

    const rows = await db
      .select({
        ended_at: chargeSession.ended_at,
        end_range_mi: chargeSession.end_range_mi,
        end_battery_level: chargeSession.end_battery_level,
      })
      .from(chargeSession)
      .where(
        and(
          eq(chargeSession.user_id, userId),
          vin ? eq(chargeSession.vin, vin) : undefined,
          isNotNull(chargeSession.ended_at),
          isNotNull(chargeSession.end_range_mi),
          isNotNull(chargeSession.end_battery_level),
        ),
      )
      .orderBy(asc(chargeSession.ended_at))

    const points: CapacityPoint[] = []
    for (const r of rows) {
      const cap = capacityKwh(r.end_range_mi, r.end_battery_level, eff)
      if (cap != null && r.ended_at) points.push({ date: r.ended_at, capacityKwh: cap })
    }
    const health = buildBatteryHealth(points)
    return {
      efficiencyWhPerMi: eff,
      currentKwh: health.currentKwh,
      maxKwh: health.maxKwh,
      degradationPct: health.degradationPct,
      projectedRangeMi: projectedRangeMi(health.currentKwh, eff),
      series: health.series,
    }
}
