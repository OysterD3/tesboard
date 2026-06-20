/**
 * Aggregate dashboard loader — ONE server function, ONE database connection.
 *
 * Why this exists: the dashboard parent route needs ~12 different reads. Calling
 * 12 separate server fns from the SSR loader meant 12 getDb() clients in a single
 * Worker request, each opening its own connection. Cloudflare caps a Worker at 6
 * simultaneous outbound connections per request, so a full-page refresh blew past
 * the limit and sockets were dropped → "Network connection lost" / "Failed query"
 * (intermittent, self-recovering, refresh-only). This fn runs every read on a
 * single shared client via `withDb`, so SSR uses one connection (≤5 sockets) and
 * stays well under the ceiling. See src/server/db.ts header.
 *
 * Each underlying read is the same `*Core(db, userId, data)` the standalone server
 * fns call, so there is no query duplication or drift.
 */
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { vinFilter } from './vin'
import { getOverviewCore, type VehicleWithLatest } from './overview.functions'
import { getDepartureReadinessCore } from './readiness.functions'
import { getDrivesCore } from './drives.functions'
import { getChargingCore } from './charging.functions'
import { getRateCore } from './rate.functions'
import { getGeofencesCore } from './geofences.functions'

/**
 * Pick the active vehicle: the requested vin if the user owns it, else the
 * most-recently-active car (latest snapshot wins; ISO timestamps sort
 * lexicographically). Null only when the account has no vehicles yet.
 */
export function resolveActiveVin(
  vehicles: VehicleWithLatest[],
  requested: string | undefined,
): string | null {
  if (vehicles.length === 0) return null
  if (requested && vehicles.some((v) => v.vehicle.vin === requested)) return requested
  let best = vehicles[0]
  let bestAt = best.latest?.recorded_at ?? ''
  for (const v of vehicles) {
    const at = v.latest?.recorded_at ?? ''
    if (at > bestAt) {
      best = v
      bestAt = at
    }
  }
  return best.vehicle.vin
}

export const getDashboardData = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }) =>
    withDb(async (db) => {
      const userId = context.userId

      // Overview carries the vehicle list (for the switcher) regardless of vin,
      // and we need it to resolve the active car before the rest.
      const overview = await getOverviewCore(db, userId, data)
      const activeVin = resolveActiveVin(overview.vehicles, data?.vin)
      const vin = activeVin ?? undefined

      // The heavier analytics reads (battery, efficiency, mileage, states,
      // timeline) + phantom-drain moved OUT of this every-route loader to keep the
      // per-request SSR CPU under the Free-plan ~10ms cap. They now load lazily in
      // their own routes' loaders: /dashboard/analytics → getAnalyticsData,
      // /dashboard/battery → getBatteryHealth. The Idles → Insights page fetches
      // getPhantomDrain/getPhantomCauses client-side (keyed on its date filter).
      const [readiness, drives, charging, rate, geofences] = await Promise.all([
        getDepartureReadinessCore(db, userId, { vin }),
        getDrivesCore(db, userId, { vin }),
        getChargingCore(db, userId, { vin }),
        getRateCore(db, userId),
        getGeofencesCore(db, userId),
      ])

      // Server-anchored "now" so the Insights pages' relative date windows
      // resolve to identical bounds on SSR and the first client render.
      return { overview, activeVin, readiness, drives, charging, rate, geofences, now: new Date().toISOString() }
    }),
  )
