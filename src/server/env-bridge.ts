/**
 * Bridge Cloudflare Worker bindings into `process.env` so our server-only env
 * reads (env.ts, db.ts) resolve. Used by BOTH the main worker entry (fetch +
 * scheduled) and the VehiclePoller Durable Object — each runs in its own context
 * that does NOT auto-populate process.env, so every entry point must bridge.
 *
 *  - String vars/secrets → process.env[k].
 *  - The Hyperdrive binding is an OBJECT (never auto-bridged); expose its
 *    connectionString as DATABASE_URL so Drizzle reaches Postgres through it.
 *    (Raw postgres-js TCP straight to Supabase HANGS in workerd.)
 */
export function bridgeEnv(env: Record<string, unknown>): void {
  if (typeof process === 'undefined' || !process.env) return
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') process.env[k] = v
  }
  const hyperdrive = env.HYPERDRIVE as { connectionString?: string } | undefined
  if (hyperdrive?.connectionString) process.env.DATABASE_URL = hyperdrive.connectionString
}
