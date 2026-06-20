/**
 * Aggregate loader for the Analytics tab — ONE server fn, ONE database connection.
 *
 * These five reads (battery health, efficiency-vs-temp/speed, mileage, state
 * timeline, recent events) used to ride inside getDashboardData, which runs on
 * EVERY dashboard route. They're only needed on /dashboard/analytics, so loading
 * them eagerly inflated the per-request SSR CPU on every other tab — and on the
 * Cloudflare Free plan (~10ms CPU/invocation) that pushed the dashboard over the
 * limit (error 1102). Splitting them here means the Analytics tab pays for them in
 * its OWN invocation (its own CPU budget) and the other tabs don't pay at all.
 *
 * Mirrors getDashboardData's single-`withDb` + Promise.all pattern so the analytics
 * SSR still uses one pooled connection. Each read is the same `*Core(db, …)` the
 * standalone server fns call — no query duplication.
 */
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { vinFilter } from './vin'
import { getBatteryHealthCore } from './battery.functions'
import { getEfficiencyAnalysisCore } from './efficiency-analysis.functions'
import { getMileageCore } from './mileage.functions'
import { getStatesCore } from './states.functions'
import { getTimelineCore } from './timeline.functions'

export const getAnalyticsData = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }) =>
    withDb(async (db) => {
      const userId = context.userId
      // `vin` is passed straight through (undefined → the user's only car, or the
      // aggregate if multi-vehicle and none selected — matching today's behaviour;
      // the active-vehicle switcher always sets `vin` once used).
      const vin = data?.vin

      const [battery, efficiency, mileage, states, timeline] = await Promise.all([
        getBatteryHealthCore(db, userId, { vin }),
        getEfficiencyAnalysisCore(db, userId, { vin, days: 365 }),
        getMileageCore(db, userId, { vin, period: 'month' }),
        getStatesCore(db, userId, { vin, days: 30 }),
        getTimelineCore(db, userId, { vin, days: 30 }),
      ])

      return { battery, efficiency, mileage, states, timeline }
    }),
  )
