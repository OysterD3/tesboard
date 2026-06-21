/**
 * Direct Drizzle/postgres-js client for the Node adapter.
 *
 * Mirrors src/server/db.ts BUT:
 *  - reads `DIRECT_URL` directly from process.env (the Supabase SESSION pooler
 *    `:5432` — NOT Cloudflare Hyperdrive, NOT the `:6543` transaction pooler; the
 *    adapter is plain Node on a VM with no workerd I/O ceiling and no bindings).
 *  - NO bridgeEnv: there are no Cloudflare bindings here.
 *  - shares the EXACT schema with the main app via the `@core` alias (-> ../../src/server).
 *
 * `prepare:false, fetch_types:false, connection:{TimeZone:'UTC'}` match the main
 * client so timestamptz text comes back UTC-normalised and the pooler stays happy.
 * `max:5` keeps the long-lived adapter pooler-friendly.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@core/schema'

/** The Drizzle client type — structurally the same as the app's `Db` (same schema). */
export type DirectDb = ReturnType<typeof drizzle<typeof schema>>

export interface DirectDbHandle {
  db: DirectDb
  close: () => Promise<void>
}

/**
 * Build a long-lived adapter DB handle. Unlike the Worker (one client per
 * request), the adapter is a single long-running process, so ONE client is held
 * for the process lifetime and closed on graceful shutdown.
 */
export function getDirectDb(directUrl: string): DirectDbHandle {
  const client = postgres(directUrl, {
    prepare: false,
    fetch_types: false,
    max: 5,
    idle_timeout: 20,
    connection: { TimeZone: 'UTC' },
  })
  const db = drizzle(client, { schema })
  return {
    db,
    close: async () => {
      try {
        await client.end({ timeout: 5 })
      } catch {
        /* ignore teardown errors */
      }
    },
  }
}
