/**
 * Drizzle database client (server-only) over postgres-js.
 *
 * Reaches Postgres via Cloudflare **Hyperdrive** — raw postgres-js TCP straight
 * to Supabase HANGS inside workerd (the local-dev and prod runtime), so the
 * worker entry (src/worker.ts) bridges `env.HYPERDRIVE.connectionString` into
 * `process.env.DATABASE_URL`, and we connect to that. Hyperdrive's origin is the
 * Supabase pooler; Hyperdrive does its own pooling. postgres-js options follow
 * Cloudflare's Hyperdrive guidance:
 *   - `prepare: false`   — safe with the Supabase pooler origin (no cross-query
 *     server-side prepared statements).
 *   - `fetch_types: false` — skip postgres-js's per-connection type-introspection
 *     round-trip (recommended with Hyperdrive / poolers).
 *   - `max: 5`          — Hyperdrive multiplexes; a small client pool is plenty.
 *
 * Migrations do NOT go through here — drizzle-kit connects directly (DIRECT_URL).
 *
 * IMPORTANT — no cross-request caching. On Cloudflare Workers an I/O object (the
 * DB socket) is bound to the request that created it and CANNOT be reused by a
 * later request ("Cannot perform I/O on behalf of a different request"). So a
 * module-level singleton breaks on the 2nd request. We build a fresh client per
 * call instead. Call `getDb()` ONCE per request/cycle and pass the result down
 * (the poller, reconcile, callback, and each server fn already do this), so a
 * request opens exactly one connection.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { serverEnv } from './env'
import * as schema from './schema'

/** Build a request-scoped Drizzle client. Do NOT hoist to module scope. */
export function getDb() {
  const { url } = serverEnv.database()
  const client = postgres(url, {
    prepare: false,
    fetch_types: false,
    max: 5,
    idle_timeout: 20, // let idle connections close instead of lingering per request
  })
  return drizzle(client, { schema })
}

/**
 * Flatten a DB error (Drizzle wraps the real postgres-js error in `.cause`) into
 * a single readable string. TanStack's SSR error serializer drops `.cause`, so
 * without this the browser only sees Drizzle's opaque "Failed query: …" wrapper.
 */
export function dbErrorMessage(e: unknown): string {
  const parts: string[] = []
  let cur = e as { message?: string; code?: string; cause?: unknown } | undefined
  let depth = 0
  while (cur && depth < 5) {
    if (cur.message) parts.push(cur.message)
    if (cur.code) parts.push(`(code ${cur.code})`)
    cur = cur.cause as typeof cur
    depth++
  }
  return parts.join(' | ') || String(e)
}

export type Db = ReturnType<typeof getDb>
