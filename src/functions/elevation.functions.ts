/**
 * On-demand elevation backfill — fills `vehicle_snapshot.elevation_m` for the
 * GPS fixes the poller stored without it (the Fleet API has no altitude). Walks a
 * bounded, newest-first window of un-elevated snapshots per call, looks each
 * batch up against Open-Meteo, and writes the results back in ONE bulk SQL update
 * per batch (so a few hundred points cost a handful of subrequests, not one each).
 *
 * Kept OFF the 2-min cron; the dashboard calls this in a loop until `remaining`
 * is 0 (like the reverse-geocode backfill). Once filled, the drive-detail
 * elevation chart + peak/ascent/descent populate for live-polled drives too.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vehicleSnapshot } from '../server/schema'
import { ELEVATION_BATCH, fillElevations } from '../server/elevation'

/** Open-Meteo requests per invocation (≥1 batch of up to 100 coords each). */
const MAX_BATCHES = 5
const SCAN = ELEVATION_BATCH * MAX_BATCHES

export interface ElevationBackfillResult {
  /** Snapshots given an elevation this run. */
  filled: number
  /** Open-Meteo requests made this run. */
  networkCalls: number
  /** Snapshots still missing elevation after this run (have GPS, no elevation). */
  remaining: number
}

export const backfillElevation = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ElevationBackfillResult> =>
    withDb((db) => backfillElevationCore(db, context.userId)),
  )

async function backfillElevationCore(db: Db, userId: string): Promise<ElevationBackfillResult> {
  const rows = await db
    .select({ id: vehicleSnapshot.id, lat: vehicleSnapshot.latitude, lng: vehicleSnapshot.longitude })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        isNotNull(vehicleSnapshot.latitude),
        isNotNull(vehicleSnapshot.longitude),
        isNull(vehicleSnapshot.elevation_m),
      ),
    )
    .orderBy(desc(vehicleSnapshot.recorded_at))
    .limit(SCAN)

  const fillRows = rows
    .filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ id: r.id, lat: r.lat as number, lng: r.lng as number }))
  const { filled, batches } = await fillElevations(db, userId, fillRows, MAX_BATCHES)

  const rem = await db
    .select({ c: count() })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        isNotNull(vehicleSnapshot.latitude),
        isNotNull(vehicleSnapshot.longitude),
        isNull(vehicleSnapshot.elevation_m),
      ),
    )
  return { filled, networkCalls: batches, remaining: rem[0]?.c ?? 0 }
}
