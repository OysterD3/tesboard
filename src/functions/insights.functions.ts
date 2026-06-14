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
import { getDb } from '../server/db'
import { vinFilter } from './vin'
import { vehicleSnapshot } from '../server/schema'

export interface PhantomDrain {
  hasData: boolean
  /** Total rated range lost to standby over the observed window (miles). */
  lostMi: number
  /** Per-day standby loss rate (miles/day). */
  perDayMi: number
  /** Days the window spans. */
  days: number
}

const WINDOW_DAYS = 7
const MAX_INTERVAL_DROP_MI = 10 // larger single-step drops are noise/data gaps, not standby

export const getPhantomDrain = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<PhantomDrain> => {
    const db = getDb()
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
          eq(vehicleSnapshot.user_id, context.userId),
          gte(vehicleSnapshot.recorded_at, since),
          vin ? eq(vehicleSnapshot.vin, vin) : undefined,
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))

    const empty: PhantomDrain = { hasData: false, lostMi: 0, perDayMi: 0, days: WINDOW_DAYS }
    if (snaps.length < 2) return empty

    const range = (s: (typeof snaps)[number]) => s.est ?? s.rng
    const parkedUnplugged = (s: (typeof snaps)[number]) =>
      (s.shift == null || s.shift === 'P') && s.charging !== 'Charging'

    let lostMi = 0
    let firstMs: number | null = null
    let lastMs = 0
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1]
      const b = snaps[i]
      const ra = range(a)
      const rb = range(b)
      const t = new Date(b.at).getTime()
      if (firstMs == null) firstMs = new Date(a.at).getTime()
      lastMs = t
      if (ra == null || rb == null) continue
      if (!parkedUnplugged(a) || !parkedUnplugged(b)) continue
      const drop = ra - rb
      if (drop > 0 && drop <= MAX_INTERVAL_DROP_MI) lostMi += drop
    }

    if (lostMi <= 0 || firstMs == null) return empty
    const spanDays = Math.max(1, (lastMs - firstMs) / 86_400_000)
    return {
      hasData: true,
      lostMi: Math.round(lostMi * 10) / 10,
      perDayMi: Math.round((lostMi / spanDays) * 10) / 10,
      days: Math.round(spanDays),
    }
  })
