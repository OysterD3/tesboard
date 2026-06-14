/**
 * Cloudflare Worker entry.
 *
 * Serves the TanStack Start app (fetch) AND runs the poller on native Cloudflare
 * Cron Triggers (scheduled) — no external scheduler needed. The cron schedules
 * are declared in wrangler.jsonc under `triggers.crons`.
 */
import startEntry from '@tanstack/react-start/server-entry'
import { runPollCycle } from './server/poller'
import { reconcileAllUsers } from './server/reconcile'

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

/**
 * Bridge Worker bindings into process.env so our server-only env reads (env.ts,
 * db.ts) resolve.
 *  - String vars/secrets → process.env[k]. A request context usually auto-
 *    populates these under nodejs_compat, but the scheduled context does not, so
 *    we always do it here.
 *  - The Hyperdrive binding is an OBJECT (never auto-bridged). Drizzle reaches
 *    Postgres through it: expose its connectionString as DATABASE_URL. (Raw
 *    postgres-js TCP straight to Supabase HANGS in workerd — Hyperdrive provides
 *    a connection the runtime can actually use, in dev and prod.)
 */
function bridgeEnv(env: Record<string, unknown>): void {
  if (typeof process === 'undefined' || !process.env) return
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') process.env[k] = v
  }
  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined
  if (hyperdrive?.connectionString) process.env.DATABASE_URL = hyperdrive.connectionString
}

export default {
  async fetch(...args: Parameters<typeof startEntry.fetch>) {
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
        } else {
          await runPollCycle()
        }
      })(),
    )
  },
}
