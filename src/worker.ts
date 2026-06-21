/**
 * Cloudflare Worker entry.
 *
 * Serves the TanStack Start app (fetch) AND runs the poller on native Cloudflare
 * Cron Triggers (scheduled) — no external scheduler needed. The cron schedules
 * are declared in wrangler.jsonc under `triggers.crons`.
 *
 * When BURST_POLL is enabled, the poll cron is also the watchdog for the per-VIN
 * VehiclePoller Durable Object: it returns the VINs that are actively driving/
 * charging and we arm/re-arm their DO (which then tight-polls ~20–30s). When the
 * flag is off, runPollCycle returns no armVins and this is a plain cron poller.
 */
import startEntry from '@tanstack/react-start/server-entry'
import { runPollCycle } from './server/poller'
import { reconcileAllUsers } from './server/reconcile'
import { mergeChargeFragmentsAllUsers } from './server/charge-merge'
import { checkLiveness } from './server/liveness'
import { withDb } from './server/db'
import { bridgeEnv } from './server/env-bridge'
// Tesla's 3p public key, bundled at build time. Cloudflare Workers Assets does NOT serve
// dot-directories (`.well-known/`), so the static file in public/ never reaches Tesla — the
// Worker must serve it. It's a PUBLIC key, safe to ship in the bundle. Required for partner
// registration + virtual-key pairing.
import teslaPublicKeyPem from '../public/.well-known/appspecific/com.tesla.3p.public-key.pem?raw'

// Durable Object class must be exported from the worker's main module.
export { VehiclePoller } from './server/vehicle-poller'

/** Tesla must be able to fetch the 3p public key here (partner registration + pairing). */
const TESLA_PUBLIC_KEY_PATH = '/.well-known/appspecific/com.tesla.3p.public-key.pem'

/** Must match a schedule in wrangler.jsonc; this one runs reconciliation. */
const RECONCILE_CRON = '0 * * * *' // hourly

interface ScheduledController {
  cron: string
  scheduledTime: number
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** Minimal shape of the per-VIN burst DO namespace (see vehicle-poller.ts). */
interface BurstNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(req: Request): Promise<Response> }
}

export default {
  async fetch(...args: Parameters<typeof startEntry.fetch>) {
    const request = args[0] as Request
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname === TESLA_PUBLIC_KEY_PATH
    ) {
      return new Response(teslaPublicKeyPem, {
        headers: {
          'content-type': 'application/x-pem-file',
          'cache-control': 'public, max-age=3600',
        },
      })
    }
    bridgeEnv(args[1] as Record<string, unknown>)
    return startEntry.fetch(...args)
  },

  async scheduled(
    event: ScheduledController,
    env: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<void> {
    bridgeEnv(env)
    ctx.waitUntil(
      (async () => {
        if (event.cron === RECONCILE_CRON) {
          await reconcileAllUsers()
          // Collapse stop/start charge fragments into one row per plug-in. Runs
          // after reconcile so newly-billed rows are folded in; idempotent, so a
          // failure here just retries next hour. Isolated from reconcile's result.
          try {
            await mergeChargeFragmentsAllUsers()
          } catch {
            /* best-effort; next hourly tick retries */
          }
          // Drive-granular liveness: flag any VIN that is online/mid-session but
          // has gone silent (matters most in telemetry mode, which has no REST
          // fallback). Best-effort + its own short-lived db client, isolated from
          // reconcile/merge above.
          try {
            await withDb((db) => checkLiveness(db))
          } catch {
            /* best-effort; next hourly tick retries */
          }
          return
        }
        const result = await runPollCycle()
        // Arm/re-arm the per-VIN burst DO for active vehicles. armVins is empty
        // unless BURST_POLL is on, so this is a no-op in the default config.
        const ns = env.POLLER as BurstNamespace | undefined
        if (ns && result.armVins.length) {
          await Promise.all(
            result.armVins.map(async ({ userId, vin }) => {
              try {
                const stub = ns.get(ns.idFromName(vin))
                await stub.fetch(
                  new Request('https://burst/start', {
                    method: 'POST',
                    body: JSON.stringify({ userId, vin }),
                  }),
                )
              } catch {
                /* best-effort arm; the next cron tick retries */
              }
            }),
          )
        }
      })(),
    )
  },
}
