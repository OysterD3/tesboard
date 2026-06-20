/**
 * Derived insights with no native Fleet API endpoint. Phantom drain (standby
 * range loss while parked + unplugged) is reconstructed from consecutive
 * `vehicle_snapshot` rows: range that drops between two readings where the car
 * is parked (no shift state) and not charging is standby loss. Reads only
 * Postgres, scoped to the user.
 *
 * The Insights date filter passes an explicit window. BOUNDED windows (7d / 30d /
 * custom ≤ 60d) pull the raw rows and run the unit-tested `buildPhantomDrain`.
 * ALL-TIME aggregates per-day in SQL (window functions) so the row volume scales
 * with the number of days, not the number of snapshots — otherwise an unbounded
 * scan would blow the Worker CPU budget. The SQL mirrors `buildPhantomDrain`'s
 * math exactly (see the inline notes).
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { rangeVinFilter, type RangeVinFilter } from './vin'
import { vehicleSnapshot } from '../server/schema'
import { buildPhantomDrain, type PhantomDay, type PhantomSnap } from '../lib/analytics-vm'
import { clampServerWindow } from '../lib/range-filter'

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

const MAX_INTERVAL_DROP_MI = 10 // larger single-step drops are noise/data gaps, not standby

const EMPTY_DRAIN: PhantomDrain = { hasData: false, lostMi: 0, perDayMi: 0, days: 0, series: [] }

export const getPhantomDrain = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(rangeVinFilter)
  .handler(async ({ data, context }): Promise<PhantomDrain> =>
    withDb((db) => getPhantomDrainCore(db, context.userId, data)),
  )

export async function getPhantomDrainCore(
  db: Db,
  userId: string,
  data: RangeVinFilter,
): Promise<PhantomDrain> {
  const vin = data?.vin
  const from = data?.from ?? null
  const to = data?.to ?? null

  // All-time (no lower bound, or an unparseable bound) → SQL per-day aggregation
  // (CPU-safe at any history size).
  const win = from == null ? null : clampServerWindow(from, to)
  if (win == null) return phantomDrainAllTime(db, userId, vin)

  // Bounded window → pull rows + the proven JS path. `win` is server-clamped to
  // MAX_CUSTOM_DAYS so a crafted request can't force an unbounded scan here.
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
        gte(vehicleSnapshot.recorded_at, win.from),
        lte(vehicleSnapshot.recorded_at, win.to),
        vin ? eq(vehicleSnapshot.vin, vin) : undefined,
      ),
    )
    .orderBy(asc(vehicleSnapshot.recorded_at))

  return buildPhantomDrain(snaps as PhantomSnap[], MAX_INTERVAL_DROP_MI)
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * All-time phantom drain, aggregated in SQL. Window functions reproduce the
 * consecutive-pair logic in `buildPhantomDrain`: range = COALESCE(est, battery);
 * both the previous and current reading parked (shift NULL/'P') and not Charging;
 * a positive drop ≤ MAX_INTERVAL_DROP_MI counts, bucketed by UTC calendar day.
 * Span uses the full min/max recorded_at (matching the JS first/last timestamp).
 */
async function phantomDrainAllTime(db: Db, userId: string, vin: string | undefined): Promise<PhantomDrain> {
  const vinCond = vin ? sql`and vin = ${vin}` : sql``
  const result = await db.execute(sql`
    with ordered as (
      select recorded_at as at,
             coalesce(est_battery_range, battery_range) as r,
             shift_state as shift,
             charging_state as charging
      from vehicle_snapshot
      where user_id = ${userId} ${vinCond}
    ),
    lagged as (
      select at, r, shift, charging,
             lag(r) over (order by at) as pr,
             lag(shift) over (order by at) as ps,
             lag(charging) over (order by at) as pc
      from ordered
    ),
    drops as (
      select (at at time zone 'UTC')::date as day, (pr - r) as drop
      from lagged
      where pr is not null and r is not null
        and (shift is null or shift = 'P') and charging is distinct from 'Charging'
        and (ps is null or ps = 'P') and pc is distinct from 'Charging'
        and (pr - r) > 0 and (pr - r) <= ${MAX_INTERVAL_DROP_MI}
    ),
    day_sums as (
      select to_char(day, 'YYYY-MM-DD') as date, round(sum(drop)::numeric, 1)::float as lost
      from drops group by day
    )
    select
      coalesce(
        (select json_agg(json_build_object('date', date, 'lostMi', lost) order by date) from day_sums),
        '[]'::json
      ) as series,
      coalesce((select sum(drop)::float from drops), 0) as raw_total,
      (select extract(epoch from (max(at) - min(at))) / 86400.0 from ordered) as span_days
  `)

  const row = (result as unknown as Array<{
    series: PhantomDay[] | null
    raw_total: number | null
    span_days: number | null
  }>)[0]

  const rawTotal = row?.raw_total ?? 0
  if (!row || rawTotal <= 0) return EMPTY_DRAIN

  const spanDays = Math.max(1, row.span_days ?? 1)
  return {
    hasData: true,
    lostMi: round1(rawTotal),
    perDayMi: round1(rawTotal / spanDays),
    days: Math.round(spanDays),
    series: row.series ?? [],
  }
}
