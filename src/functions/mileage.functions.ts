/**
 * Mileage / cumulative-odometer reports per day/week/month/year. Read-only;
 * authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { driveSession } from '../server/schema'
import { bucketMileage, type MileageBucket, type MileagePeriod } from '../lib/analytics-vm'

const input = z.object({
  vin: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year']).default('month'),
})
export type MileageInput = z.infer<typeof input>

export interface MileageResult {
  period: MileagePeriod
  buckets: MileageBucket[]
  totalMi: number
  currentOdometerMi: number | null
}

export const getMileage = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }): Promise<MileageResult> =>
    withDb((db) => getMileageCore(db, context.userId, data)),
  )

export async function getMileageCore(
  db: Db,
  userId: string,
  data: MileageInput,
): Promise<MileageResult> {
    const rows = await db
      .select({
        started_at: driveSession.started_at,
        distance_mi: driveSession.distance_mi,
        end_odometer: driveSession.end_odometer,
      })
      .from(driveSession)
      .where(
        and(
          eq(driveSession.user_id, userId),
          data.vin ? eq(driveSession.vin, data.vin) : undefined,
        ),
      )
      .orderBy(asc(driveSession.started_at))

    const buckets = bucketMileage(rows, data.period)
    const totalMi = buckets.reduce((a, b) => a + b.distanceMi, 0)
    const currentOdometerMi =
      [...rows].reverse().find((r) => r.end_odometer != null)?.end_odometer ?? null
    return { period: data.period, buckets, totalMi, currentOdometerMi }
}
