/**
 * Efficiency vs outside temperature — TeslaMate's signature consumption chart.
 * Joins each drive's wh_per_mi to its window-average outside temp (captured at
 * drive close), binned into temperature buckets. Read-only; user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, eq, gte, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { driveSession } from '../server/schema'
import { binConsumptionByTemp, type ConsumptionBin, type ConsumptionPoint } from '../lib/analytics-vm'

const input = z.object({ vin: z.string().optional(), days: z.number().int().min(1).max(3650).default(365) })

export interface EfficiencyAnalysisResult {
  bins: ConsumptionBin[]
  points: ConsumptionPoint[]
  avgWhPerMi: number | null
  sampleCount: number
}

export const getEfficiencyAnalysis = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }): Promise<EfficiencyAnalysisResult> => {
    const db = getDb()
    const since = new Date(Date.now() - data.days * 86400_000).toISOString()
    const rows = await db
      .select({ whPerMi: driveSession.wh_per_mi, tempC: driveSession.outside_temp_avg })
      .from(driveSession)
      .where(
        and(
          eq(driveSession.user_id, context.userId),
          data.vin ? eq(driveSession.vin, data.vin) : undefined,
          gte(driveSession.started_at, since),
          isNotNull(driveSession.wh_per_mi),
          isNotNull(driveSession.outside_temp_avg),
        ),
      )

    const points: ConsumptionPoint[] = rows
      .filter((r) => r.whPerMi != null && r.tempC != null && r.whPerMi > 0)
      .map((r) => ({ tempC: r.tempC as number, whPerMi: r.whPerMi as number }))
    const avg = points.length ? points.reduce((a, p) => a + p.whPerMi, 0) / points.length : null
    return {
      bins: binConsumptionByTemp(points),
      points: points.slice(0, 500),
      avgWhPerMi: avg,
      sampleCount: points.length,
    }
  })
