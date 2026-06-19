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
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vehicleSnapshot } from '../server/schema'
import { ELEVATION_BATCH, lookupElevations } from '../server/elevation'

/** Open-Meteo requests per invocation (≥1 batch of up to 100 coords each). */
const MAX_BATCHES = 5
const NETWORK_GAP_MS = 400
const SCAN = ELEVATION_BATCH * MAX_BATCHES

export interface ElevationBackfillResult {
  /** Snapshots given an elevation this run. */
  filled: number
  /** Open-Meteo requests made this run. */
  networkCalls: number
  /** Snapshots still missing elevation after this run (have GPS, no elevation). */
  remaining: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

  let filled = 0
  let networkCalls = 0
  for (let i = 0; i < rows.length; i += ELEVATION_BATCH) {
    const chunk = rows.slice(i, i + ELEVATION_BATCH)
    if (networkCalls > 0) await sleep(NETWORK_GAP_MS)
    const els = await lookupElevations(chunk.map((r) => [r.lat as number, r.lng as number]))
    networkCalls++

    const pairs: { id: number; ele: number }[] = []
    for (let j = 0; j < chunk.length; j++) {
      const e = els[j]
      if (e != null) pairs.push({ id: chunk[j].id, ele: Math.round(e) })
    }
    if (pairs.length === 0) continue

    // One bulk update per batch: join the snapshots to a VALUES list by id. The
    // user_id predicate keeps the write scoped even though the ids are the user's.
    const valuesSql = sql.join(
      pairs.map((p) => sql`(${p.id}::bigint, ${p.ele}::int)`),
      sql`, `,
    )
    await db.execute(sql`
      update vehicle_snapshot as v
      set elevation_m = d.ele
      from (values ${valuesSql}) as d(id, ele)
      where v.id = d.id and v.user_id = ${userId}
    `)
    filled += pairs.length
  }

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
  return { filled, networkCalls, remaining: rem[0]?.c ?? 0 }
}
