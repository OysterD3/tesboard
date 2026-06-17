/**
 * GET /api/auth/tesla/callback
 * Tesla redirects here with ?code & ?state. We verify state against the cookie,
 * exchange the code for tokens, persist them (encrypted) against the signed-in
 * user, resolve the region, and snapshot the vehicle list. Read-only throughout.
 *
 * This is a server ROUTE (a third-party browser redirect URL), never a server fn.
 */
import { createFileRoute } from '@tanstack/react-router'
import { getRequestUrl } from '@tanstack/react-start/server'
import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { exchangeCodeForToken, getUserRegion } from '../../../../server/tesla/oauth'
import { clearOAuthCookie, readOAuthCookie } from '../../../../server/oauth-cookie'
import { getSessionUser } from '../../../../server/db.server'
import { withDb } from '../../../../server/db'
import { teslaAccount, vehicle } from '../../../../server/schema'
import { saveToken } from '../../../../server/tesla/token-store'
import { createTeslaClient, listVehicles } from '../../../../server/tesla/client.server'
import { serverEnv } from '../../../../server/env'

export const Route = createFileRoute('/api/auth/tesla/callback')({
  server: {
    handlers: {
      GET: async () => {
        // OAuth callbacks must always end in a redirect — never a raw 500. h3
        // redacts unhandled errors to the opaque `{message:"HTTPError"}`, so we
        // catch here and forward the REAL reason as ?tesla_error=… for the user.
        try {
          return await handleCallback()
        } catch (err) {
          // Log the full error server-side, but keep the user-facing redirect
          // clean: never leak query params (which can include encrypted token
          // values) into the URL. Show only the reason, before any "params:".
          console.error('Tesla callback failed:', err)
          const raw = err instanceof Error ? err.message : String(err)
          const message = raw.split('\nparams:')[0].slice(0, 300)
          return redirectTo(`/dashboard?tesla_error=${encodeURIComponent(message)}`)
        }
      },
    },
  },
})

async function handleCallback(): Promise<Response> {
  const url = getRequestUrl()
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  const stash = readOAuthCookie()
  clearOAuthCookie()

  if (error) return redirectTo(`/dashboard?tesla_error=${encodeURIComponent(error)}`)
  if (!code || !state || !stash || !safeEqual(stash.state, state)) {
    return redirectTo('/dashboard?tesla_error=invalid_state')
  }

  const user = await getSessionUser()
  if (!user) return redirectTo('/login')
  // The flow must complete as the same user who started it (guards
  // session-swap / shared-browser linking to the wrong account).
  if (stash.uid !== user.id) {
    return redirectTo('/dashboard?tesla_error=invalid_state')
  }

  const token = await exchangeCodeForToken({ code, codeVerifier: stash.verifier })

  return await withDb(async (db) => {
  await saveToken(db, user.id, token)

  // Seed account row, then resolve the correct regional base URL.
  const seedBase = serverEnv.tesla().fleetBaseUrl
  const nowIso = new Date().toISOString()
  await db
    .insert(teslaAccount)
    .values({
      user_id: user.id,
      user_email: user.email ?? null,
      fleet_api_base_url: seedBase,
      linked_at: nowIso,
      updated_at: nowIso,
    })
    .onConflictDoUpdate({
      target: teslaAccount.user_id,
      set: {
        user_email: user.email ?? null,
        fleet_api_base_url: seedBase,
        linked_at: nowIso,
        updated_at: nowIso,
      },
    })

  try {
    const region = await getUserRegion(token.access_token, seedBase)
    await db
      .update(teslaAccount)
      .set({
        fleet_api_base_url: region.response.fleet_api_base_url,
        region: region.response.region,
        updated_at: new Date().toISOString(),
      })
      .where(eq(teslaAccount.user_id, user.id))
  } catch {
    // Region lookup is best-effort; the seed base URL still works for NA/APAC.
  }

  // Snapshot the vehicle list so the dashboard has names/ids immediately.
  try {
    const ctx = await createTeslaClient(db, user.id)
    const vehicles = await listVehicles(ctx)
    for (const v of vehicles) {
      const vNow = new Date().toISOString()
      await db
        .insert(vehicle)
        .values({
          vin: v.vin,
          user_id: user.id,
          tesla_id: String(v.id),
          vehicle_id: v.vehicle_id != null ? String(v.vehicle_id) : null,
          display_name: v.display_name,
          car_type: v.car_type ?? null,
          last_state: v.state,
          updated_at: vNow,
        })
        .onConflictDoUpdate({
          target: vehicle.vin,
          set: {
            user_id: user.id,
            tesla_id: String(v.id),
            vehicle_id: v.vehicle_id != null ? String(v.vehicle_id) : null,
            display_name: v.display_name,
            car_type: v.car_type ?? null,
            last_state: v.state,
            updated_at: vNow,
          },
        })
    }
  } catch {
    // Non-fatal; the poller will reconcile vehicles on its next run.
  }

  return redirectTo('/dashboard?tesla_linked=1')
  })
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function redirectTo(location: string): Response {
  const url = location.startsWith('http')
    ? location
    : `${serverEnv.app().origin}${location}`
  return new Response(null, { status: 302, headers: { Location: url } })
}
