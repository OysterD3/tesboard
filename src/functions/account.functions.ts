/**
 * Lightweight auth/link status used by route guards and the dashboard header.
 * getAuthStatus does NOT throw (so beforeLoad can branch); data fns use
 * authMiddleware instead.
 */
import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { dbErrorMessage, getDb } from '../server/db'
import { getSessionUser } from '../server/db.server'
import { teslaAccount, teslaToken, vehicle } from '../server/schema'
import { createTeslaClient, listVehicles } from '../server/tesla/client.server'
import { getUserRegion } from '../server/tesla/oauth'
import { getValidAccessToken } from '../server/tesla/token-store'

export interface AuthStatus {
  authed: boolean
  email: string | null
  teslaLinked: boolean
}

export const getAuthStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AuthStatus> => {
    const user = await getSessionUser()
    if (!user) return { authed: false, email: null, teslaLinked: false }

    const db = getDb()
    try {
      const rows = await db
        .select({ user_id: teslaToken.user_id })
        .from(teslaToken)
        .where(eq(teslaToken.user_id, user.id))
        .limit(1)
      return { authed: true, email: user.email ?? null, teslaLinked: rows.length > 0 }
    } catch (e) {
      // Surface the real postgres-js cause (otherwise SSR serialization hides it).
      throw new Error(`getAuthStatus DB query failed: ${dbErrorMessage(e)}`)
    }
  },
)

export interface ResyncResult {
  ok: boolean
  vehicleCount: number
  region: string | null
  message: string
}

/**
 * On-demand re-pull from Tesla: resolve the account region, then list vehicles
 * and upsert them. Returns the exact Fleet API error on failure (e.g. a 412 when
 * partner registration hasn't been done) instead of swallowing it like the
 * link-time best-effort path does.
 */
export const resyncTesla = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ResyncResult> => {
    const db = getDb()
    const userId = context.userId

    // 1) Resolve region (best-effort; capture but don't fail the whole sync).
    let region: string | null = null
    let regionWarning: string | null = null
    try {
      const accountRows = await db
        .select({ base: teslaAccount.fleet_api_base_url })
        .from(teslaAccount)
        .where(eq(teslaAccount.user_id, userId))
        .limit(1)
      const seedBase =
        accountRows[0]?.base || process.env.TESLA_FLEET_BASE_URL || ''
      const token = await getValidAccessToken(db, userId)
      const r = await getUserRegion(token, seedBase)
      region = r.response.region ?? null
      await db
        .update(teslaAccount)
        .set({
          fleet_api_base_url: r.response.fleet_api_base_url,
          region,
          updated_at: new Date().toISOString(),
        })
        .where(eq(teslaAccount.user_id, userId))
    } catch (e) {
      regionWarning = dbErrorMessage(e)
    }

    // 2) List + upsert vehicles. This is the call that needs partner registration.
    try {
      const ctx = await createTeslaClient(db, userId)
      const vehicles = await listVehicles(ctx)
      for (const v of vehicles) {
        const now = new Date().toISOString()
        await db
          .insert(vehicle)
          .values({
            vin: v.vin,
            user_id: userId,
            tesla_id: String(v.id),
            vehicle_id: v.vehicle_id != null ? String(v.vehicle_id) : null,
            display_name: v.display_name,
            car_type: v.car_type ?? null,
            last_state: v.state,
            updated_at: now,
          })
          .onConflictDoUpdate({
            target: vehicle.vin,
            set: {
              user_id: userId,
              tesla_id: String(v.id),
              vehicle_id: v.vehicle_id != null ? String(v.vehicle_id) : null,
              display_name: v.display_name,
              car_type: v.car_type ?? null,
              last_state: v.state,
              updated_at: now,
            },
          })
      }
      return {
        ok: true,
        vehicleCount: vehicles.length,
        region,
        message:
          vehicles.length > 0
            ? `Synced ${vehicles.length} vehicle(s).`
            : 'Tesla returned no vehicles for this account.',
      }
    } catch (e) {
      return {
        ok: false,
        vehicleCount: 0,
        region,
        message: `${dbErrorMessage(e)}${regionWarning ? ` | region lookup also failed: ${regionWarning}` : ''}`,
      }
    }
  })
