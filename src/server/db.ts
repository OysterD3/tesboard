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
 *   - `max: 5`          — Cloudflare caps a Worker at **6 simultaneous open
 *     outbound connections per request**; 7+ queue and a pool that holds some open
 *     while waiting for more can DEADLOCK / get sockets dropped → "Network
 *     connection lost". `max: 5` keeps one client safely under that ceiling. The
 *     hard rule this enforces: **exactly ONE getDb() client per request.** The SSR
 *     dashboard loader used to fan out ~12 server fns, each calling getDb() in the
 *     SAME request → 12 clients × ≥1 socket = >6 simultaneous connections → random,
 *     self-recovering "Failed query / Network connection lost" (only on refresh,
 *     since client-side navigation issues each fn as its own request). The fix:
 *     the dashboard loader now calls ONE aggregate server fn (getDashboardData)
 *     that shares a single client via `withDb`. Always wrap DB work in `withDb`.
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
    max: 5, // see header — ≤6 simultaneous outbound conns per Worker request
    idle_timeout: 20, // backstop close of idle sockets (withDb closes explicitly)
    // Pin the session zone so timestamptz text comes back UTC-normalised. Code that
    // buckets a day via `iso.slice(0,10)` then matches SQL `at time zone 'UTC'`
    // (e.g. phantom-drain bounded JS vs all-time SQL) regardless of server defaults.
    connection: { TimeZone: 'UTC' },
  })
  return drizzle(client, { schema })
}

/**
 * Run DB work on a single request-scoped client, then CLOSE it.
 *
 * Closing matters on Cloudflare Workers: an unclosed postgres-js pool keeps its
 * sockets open (until idle_timeout), and those count against the per-request
 * 6-connection ceiling. `withDb` guarantees exactly one client per call and frees
 * its sockets as soon as the work finishes — so concurrent server fns (or the
 * aggregate dashboard loader) never accumulate connections. Pass the injected
 * `db` straight to the query helpers; do NOT call getDb() again inside `fn`.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = getDb()
  try {
    return await fn(db)
  } finally {
    // Best-effort close; a failed teardown must not mask the real result/error.
    try {
      await db.$client.end({ timeout: 5 })
    } catch {
      /* ignore */
    }
  }
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
