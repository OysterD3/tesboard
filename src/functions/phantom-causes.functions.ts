/**
 * Phantom / vampire standby-loss CAUSE attribution. Correlates each parked
 * standby range-drop with what was active over that interval (Sentry, climate,
 * cold, awake-idle, or a sleep gap) — a heuristic, since Tesla exposes no
 * per-subsystem energy. Live-poll rows only (imports carry no cause flags).
 *
 * Deliberately a STANDALONE server fn (not part of getDashboardData): it reads
 * the sentry_mode / is_climate_on / is_preconditioning columns added in a later
 * migration, so it is wrapped to degrade to `available:false` if that migration
 * has not been applied yet — a missing column can never break the dashboard.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { rangeVinFilter } from './vin'
import { vehicleSnapshot } from '../server/schema'
import {
  buildCauseSlices,
  buildPhantomCauses,
  type PhantomCause,
  type PhantomCauseSnap,
  type PhantomCauseSlice,
} from '../lib/analytics-vm'

const MAX_INTERVAL_DROP_MI = 10
// Windows up to this span pull raw rows (tested JS); wider ones aggregate in SQL.
const JS_WINDOW_MAX_DAYS = 60

export interface PhantomCausesPayload {
  /** False when the cause-flag columns don't exist yet (migration not applied). */
  available: boolean
  hasData: boolean
  totalMi: number
  slices: PhantomCauseSlice[]
  /** Live rows in the window still missing cause flags (backfill candidates). */
  unattributed: number
}

const EMPTY: PhantomCausesPayload = { available: true, hasData: false, totalMi: 0, slices: [], unattributed: 0 }

export const getPhantomCauses = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(rangeVinFilter)
  .handler(async ({ data, context }): Promise<PhantomCausesPayload> =>
    withDb(async (db) => {
      const userId = context.userId
      const vin = data?.vin
      const from = data?.from ?? null
      const to = data?.to ?? null
      try {
        // No lower bound (or unparseable) → all-time SQL aggregation.
        const fromMs = from ? Date.parse(from) : NaN
        if (from == null || Number.isNaN(fromMs)) return await causesAggregated(db, userId, vin, null, null)

        // Wide window → bounded SQL aggregation (CPU-safe; can't be forced unbounded).
        const toMs = to ? Date.parse(to) : NaN
        const spanDays = ((Number.isNaN(toMs) ? Date.now() : toMs) - fromMs) / 86_400_000
        if (spanDays > JS_WINDOW_MAX_DAYS) return await causesAggregated(db, userId, vin, from, to)

        // Small bounded window → pull rows + the proven JS path.
        const snaps = await db
          .select({
            est: vehicleSnapshot.est_battery_range,
            rng: vehicleSnapshot.battery_range,
            charging: vehicleSnapshot.charging_state,
            shift: vehicleSnapshot.shift_state,
            at: vehicleSnapshot.recorded_at,
            outsideC: vehicleSnapshot.outside_temp,
            sentry: vehicleSnapshot.sentry_mode,
            climate: vehicleSnapshot.is_climate_on,
            precond: vehicleSnapshot.is_preconditioning,
          })
          .from(vehicleSnapshot)
          .where(
            and(
              eq(vehicleSnapshot.user_id, userId),
              gte(vehicleSnapshot.recorded_at, from),
              to ? lte(vehicleSnapshot.recorded_at, to) : undefined,
              vin ? eq(vehicleSnapshot.vin, vin) : undefined,
            ),
          )
          .orderBy(asc(vehicleSnapshot.recorded_at))

        const rows: PhantomCauseSnap[] = snaps.map((s) => ({
          est: s.est,
          rng: s.rng,
          charging: s.charging,
          shift: s.shift,
          at: s.at,
          outsideC: s.outsideC,
          sentry: s.sentry,
          climateOn: s.climate || s.precond || null,
        }))

        const result = buildPhantomCauses(rows, MAX_INTERVAL_DROP_MI)
        const unattributed = snaps.filter(
          (s) => s.sentry == null && (s.shift == null || s.shift === 'P') && s.charging !== 'Charging',
        ).length
        return { available: true, ...result, unattributed }
      } catch {
        // Most likely the cause-flag columns don't exist yet (migration pending).
        return { ...EMPTY, available: false }
      }
    }),
  )

/**
 * Cause attribution aggregated in SQL over an optional [from,to] window (both
 * null = all-time). Same LAG window-function pattern as the phantom-drain
 * aggregation, with the cause CASE mirroring `buildPhantomCauses`' priority
 * (sleep gap → Sentry → climate → cold → awake). Throws if the cause columns are
 * absent — the caller's catch turns that into `available:false`.
 */
async function causesAggregated(
  db: Db,
  userId: string,
  vin: string | undefined,
  from: string | null,
  to: string | null,
): Promise<PhantomCausesPayload> {
  const vinCond = vin ? sql`and vin = ${vin}` : sql``
  const fromCond = from ? sql`and recorded_at >= ${from}` : sql``
  const toCond = to ? sql`and recorded_at <= ${to}` : sql``
  const result = await db.execute(sql`
    with ordered as (
      select recorded_at as at,
             coalesce(est_battery_range, battery_range) as r,
             shift_state as shift,
             charging_state as charging,
             outside_temp as oc,
             sentry_mode as sentry,
             (coalesce(is_climate_on, false) or coalesce(is_preconditioning, false)) as climate
      from vehicle_snapshot
      where user_id = ${userId} ${vinCond} ${fromCond} ${toCond}
    ),
    lagged as (
      select at, r, shift, charging, oc, sentry, climate,
             lag(r) over (order by at) as pr,
             lag(shift) over (order by at) as ps,
             lag(charging) over (order by at) as pc,
             lag(at) over (order by at) as pat,
             lag(sentry) over (order by at) as psentry,
             lag(climate) over (order by at) as pclimate
      from ordered
    ),
    drops as (
      select (pr - r) as drop,
        case
          when extract(epoch from (at - pat)) / 60.0 > 12 then 'asleep'
          when coalesce(psentry, false) or coalesce(sentry, false) then 'sentry'
          when coalesce(pclimate, false) or coalesce(climate, false) then 'climate'
          when oc is not null and oc <= 5 then 'cold'
          else 'awake'
        end as cause
      from lagged
      where pr is not null and r is not null
        and (shift is null or shift = 'P') and charging is distinct from 'Charging'
        and (ps is null or ps = 'P') and pc is distinct from 'Charging'
        and (pr - r) > 0 and (pr - r) <= ${MAX_INTERVAL_DROP_MI}
    )
    select
      coalesce(
        (select json_agg(json_build_object('cause', cause, 'lost', lost))
         from (select cause, sum(drop)::float as lost from drops group by cause) t),
        '[]'::json
      ) as causes,
      (select count(*)::int from ordered
       where sentry is null and (shift is null or shift = 'P') and charging is distinct from 'Charging'
      ) as unattributed
  `)

  const row = (result as unknown as Array<{
    causes: Array<{ cause: PhantomCause; lost: number }> | null
    unattributed: number | null
  }>)[0]

  const totals = new Map<PhantomCause, number>((row?.causes ?? []).map((c) => [c.cause, c.lost]))
  const slices = buildCauseSlices(totals)
  return { available: true, ...slices, unattributed: row?.unattributed ?? 0 }
}

export interface BackfillFlagsResult {
  available: boolean
  updated: number
  remaining: number
}

/**
 * Backfill the standby cause-flag columns for historical live rows from the
 * stored `raw_json` (the full vehicle_data payload). One efficient UPDATE per
 * call over a bounded batch; only touches rows whose payload actually carries
 * the keys, so it converges (rows without them stay null → attributed as
 * awake/asleep, not re-scanned forever).
 */
export const backfillStandbyFlags = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<BackfillFlagsResult> =>
    withDb(async (db) => {
      const userId = context.userId
      try {
        const res = await db.execute(sql`
          update vehicle_snapshot s set
            sentry_mode = (s.raw_json->'vehicle_state'->>'sentry_mode')::boolean,
            is_climate_on = (s.raw_json->'climate_state'->>'is_climate_on')::boolean,
            is_preconditioning = (s.raw_json->'climate_state'->>'is_preconditioning')::boolean
          where s.id in (
            select id from vehicle_snapshot
            where user_id = ${userId}
              and import_source = 'live'
              and sentry_mode is null
              and raw_json is not null
              and jsonb_exists(raw_json->'vehicle_state', 'sentry_mode')
            order by recorded_at desc
            limit 2000
          )
        `)
        const updated = (res as unknown as { count?: number }).count ?? 0

        const [rem] = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(vehicleSnapshot)
          .where(
            and(
              eq(vehicleSnapshot.user_id, userId),
              eq(vehicleSnapshot.import_source, 'live'),
              isNull(vehicleSnapshot.sentry_mode),
              isNotNull(vehicleSnapshot.raw_json),
              sql`jsonb_exists(${vehicleSnapshot.raw_json}->'vehicle_state', 'sentry_mode')`,
            ),
          )
        return { available: true, updated, remaining: rem?.c ?? 0 }
      } catch {
        return { available: false, updated: 0, remaining: 0 }
      }
    }),
  )
