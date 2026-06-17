/**
 * Derived insights with no native Fleet API endpoint. Phantom drain (standby
 * range loss while parked + unplugged) is reconstructed from consecutive
 * `vehicle_snapshot` rows: range that drops between two readings where the car
 * is parked (no shift state) and not charging is standby loss. Reads only
 * Postgres, scoped to the user.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gte } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vinFilter, type VinFilter } from './vin'
import { vehicleSnapshot } from '../server/schema'
import { buildPhantomDrain, type PhantomDay, type PhantomSnap } from '../lib/analytics-vm'

export interface PhantomDrain {
  hasData: boolean
  /** Total rated range lost to standby over the observed window (miles). */
  lostMi: number
  /** Per-day standby loss rate (miles/day). */
  perDayMi: number
  /** Days the window spans. */
  days: number
  /** Per-UTC-day standby loss (chronological) — drives the trend sparkline. */
  series: PhantomDay[]
}

const WINDOW_DAYS = 30
const MAX_INTERVAL_DROP_MI = 10 // larger single-step drops are noise/data gaps, not standby

export const getPhantomDrain = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<PhantomDrain> =>
    withDb((db) => getPhantomDrainCore(db, context.userId, data)),
  )

export async function getPhantomDrainCore(
  db: Db,
  userId: string,
  data: VinFilter,
): Promise<PhantomDrain> {
    const vin = data?.vin
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

    const snaps = await db
      .select({
        est: vehicleSnapshot.est_battery_range,
        rng: vehicleSnapshot.battery_range,
        charging: vehicleSnapshot.charging_state,
        shift: vehicleSnapshot.shift_state,
        at: vehicleSnapshot.recorded_at,
      })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          gte(vehicleSnapshot.recorded_at, since),
          vin ? eq(vehicleSnapshot.vin, vin) : undefined,
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))

    return buildPhantomDrain(snaps as PhantomSnap[], MAX_INTERVAL_DROP_MI)
}
