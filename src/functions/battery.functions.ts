/**
 * Battery health / degradation + projected range. Derived entirely from data we
 * already capture (rated range + usable SOC at charge endpoints) × the per-vehicle
 * efficiency factor. Read-only; authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { chargeSession, driveSession, vehicle } from '../server/schema'
import {
  buildBatteryHealth,
  buildBatteryReadings,
  projectedRangeMi,
  recentMean,
  type BatteryReading,
  type CapacityPoint,
  type OdoSample,
} from '../lib/analytics-vm'
import { vinFilter, type VinFilter } from './vin'

/** Only readings after a substantial charge are clean enough to trend (Tessie
 *  collects after every >5 kWh charge — small top-ups barely move rated range,
 *  so SOC rounding dominates and the capacity estimate gets noisy). */
const MIN_CHARGE_KWH = 5

export interface BatteryHealthResult {
  efficiencyWhPerMi: number | null
  currentKwh: number | null
  maxKwh: number | null
  degradationPct: number | null
  projectedRangeMi: number | null
  /** Current max range at 100% (recent mean of readings; efficiency-free). */
  currentMaxRangeMi: number | null
  /** Best max range ever observed (≈ original). */
  maxRangeBestMi: number | null
  /** Per-charge readings for the capacity + max-range scatter charts. */
  readings: BatteryReading[]
  /** Capacity-only series kept for the compact analytics sparkline. */
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

  const chargeRows = await db
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
        gt(chargeSession.energy_added_kwh, MIN_CHARGE_KWH),
      ),
    )
    .orderBy(asc(chargeSession.ended_at))

  // Odometer isn't stored on charge_session — derive it from the drive that
  // brought the car to the charger (the last drive endpoint at/before the read).
  const driveRows = await db
    .select({ ended_at: driveSession.ended_at, end_odometer: driveSession.end_odometer })
    .from(driveSession)
    .where(
      and(
        eq(driveSession.user_id, userId),
        vin ? eq(driveSession.vin, vin) : undefined,
        isNotNull(driveSession.ended_at),
        isNotNull(driveSession.end_odometer),
      ),
    )
    .orderBy(asc(driveSession.ended_at))

  const odo: OdoSample[] = driveRows
    .filter((r): r is { ended_at: string; end_odometer: number } =>
      r.ended_at != null && r.end_odometer != null,
    )
    .map((r) => ({ at: r.ended_at, odometer: r.end_odometer }))

  const readings = buildBatteryReadings(
    chargeRows
      .filter((r): r is typeof r & { ended_at: string } => r.ended_at != null)
      .map((r) => ({ date: r.ended_at, endRangeMi: r.end_range_mi, endSoc: r.end_battery_level })),
    odo,
    eff,
  )

  // Capacity summary (efficiency-dependent) from the readings that produced one.
  const capPoints: CapacityPoint[] = readings
    .filter((r): r is BatteryReading & { capacityKwh: number } => r.capacityKwh != null)
    .map((r) => ({ date: r.date, capacityKwh: r.capacityKwh }))
  const health = buildBatteryHealth(capPoints)

  // Max-range summary (efficiency-free) — readings are already chronological.
  const maxRanges = readings
    .filter((r): r is BatteryReading & { maxRangeMi: number } => r.maxRangeMi != null)
    .map((r) => r.maxRangeMi)
  const currentMaxRangeMi = recentMean(maxRanges)
  const maxRangeBestMi = maxRanges.length ? Math.max(...maxRanges) : null

  return {
    efficiencyWhPerMi: eff,
    currentKwh: health.currentKwh,
    maxKwh: health.maxKwh,
    degradationPct: health.degradationPct,
    projectedRangeMi: projectedRangeMi(health.currentKwh, eff),
    currentMaxRangeMi,
    maxRangeBestMi,
    readings,
    series: health.series,
  }
}
