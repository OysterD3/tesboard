/**
 * Efficiency vs outside temperature — TeslaMate's signature consumption chart.
 * Joins each drive's wh_per_mi to its window-average outside temp (captured at
 * drive close), binned into temperature buckets. Read-only; user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, eq, gte, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { driveSession } from '../server/schema'
import {
  binConsumptionBySpeed,
  binConsumptionByTemp,
  type ConsumptionBin,
  type ConsumptionPoint,
  type SpeedConsumptionBin,
  type SpeedConsumptionPoint,
} from '../lib/analytics-vm'

const input = z.object({ vin: z.string().optional(), days: z.number().int().min(1).max(3650).default(365) })
export type EfficiencyInput = z.infer<typeof input>

/** Reject derived average speeds outside a believable band — a glitched
 *  odometer/clock pairing can imply an impossible mph that would skew a bucket. */
const MAX_PLAUSIBLE_AVG_MPH = 120

export interface EfficiencyAnalysisResult {
  bins: ConsumptionBin[]
  points: ConsumptionPoint[]
  avgWhPerMi: number | null
  sampleCount: number
  /** Efficiency binned by each drive's average speed (distance ÷ moving time). */
  speedBins: SpeedConsumptionBin[]
  speedPoints: SpeedConsumptionPoint[]
  speedAvgWhPerMi: number | null
  speedSampleCount: number
}

export const getEfficiencyAnalysis = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }): Promise<EfficiencyAnalysisResult> =>
    withDb((db) => getEfficiencyAnalysisCore(db, context.userId, data)),
  )

export async function getEfficiencyAnalysisCore(
  db: Db,
  userId: string,
  data: EfficiencyInput,
): Promise<EfficiencyAnalysisResult> {
    const since = new Date(Date.now() - data.days * 86400_000).toISOString()
    // One read powers both charts. Require only wh_per_mi at the SQL level so a
    // drive missing outside-temp can still feed the speed chart (and vice versa);
    // each chart applies its own field requirements below.
    const rows = await db
      .select({
        whPerMi: driveSession.wh_per_mi,
        tempC: driveSession.outside_temp_avg,
        distanceMi: driveSession.distance_mi,
        durationS: driveSession.duration_s,
      })
      .from(driveSession)
      .where(
        and(
          eq(driveSession.user_id, userId),
          data.vin ? eq(driveSession.vin, data.vin) : undefined,
          gte(driveSession.started_at, since),
          isNotNull(driveSession.wh_per_mi),
        ),
      )

    const points: ConsumptionPoint[] = rows
      .filter((r) => r.whPerMi != null && r.tempC != null && r.whPerMi > 0)
      .map((r) => ({ tempC: r.tempC as number, whPerMi: r.whPerMi as number }))
    const avg = points.length ? points.reduce((a, p) => a + p.whPerMi, 0) / points.length : null

    // Average speed = distance ÷ moving time (mph), per drive. Needs positive
    // distance + duration; reject implausible derived speeds (bad odo/clock).
    const speedPoints: SpeedConsumptionPoint[] = rows
      .filter(
        (r) =>
          r.whPerMi != null &&
          r.whPerMi > 0 &&
          r.distanceMi != null &&
          r.distanceMi > 0 &&
          r.durationS != null &&
          r.durationS > 0,
      )
      .map((r) => ({
        speedMph: ((r.distanceMi as number) / (r.durationS as number)) * 3600,
        whPerMi: r.whPerMi as number,
      }))
      .filter((p) => p.speedMph > 0 && p.speedMph < MAX_PLAUSIBLE_AVG_MPH)
    const speedAvg = speedPoints.length
      ? speedPoints.reduce((a, p) => a + p.whPerMi, 0) / speedPoints.length
      : null

    return {
      bins: binConsumptionByTemp(points),
      points: points.slice(0, 500),
      avgWhPerMi: avg,
      sampleCount: points.length,
      speedBins: binConsumptionBySpeed(speedPoints),
      speedPoints: speedPoints.slice(0, 500),
      speedAvgWhPerMi: speedAvg,
      speedSampleCount: speedPoints.length,
    }
}
