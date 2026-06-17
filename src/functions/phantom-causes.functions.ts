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
import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { vinFilter } from './vin'
import { vehicleSnapshot } from '../server/schema'
import { buildPhantomCauses, type PhantomCauseSnap, type PhantomCauseSlice } from '../lib/analytics-vm'

const WINDOW_DAYS = 30
const MAX_INTERVAL_DROP_MI = 10

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
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<PhantomCausesPayload> =>
    withDb(async (db) => {
      const userId = context.userId
      const vin = data?.vin
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
      try {
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
              gte(vehicleSnapshot.recorded_at, since),
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
