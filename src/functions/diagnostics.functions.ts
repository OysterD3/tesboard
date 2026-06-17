/**
 * DB-info diagnostics (TeslaMate's "Database Information" dashboard parity, scaled
 * to a single user). Read-only: per-table row counts confined to the signed-in
 * user plus the database's on-disk size. authMiddleware + user_id scoping
 * throughout. Counts are the user's own rows, not global table sizes, so this
 * never leaks cross-user volume.
 */
import { createServerFn } from '@tanstack/react-start'
import { count, eq, sql } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import {
  address,
  chargeSession,
  driveSession,
  geofence,
  softwareUpdate,
  vehicle,
  vehicleSnapshot,
  vehicleState,
} from '../server/schema'

export interface DbInfo {
  tables: { name: string; rows: number }[]
  /** Whole-database on-disk size, human-formatted (e.g. "42 MB"), or null if unreadable. */
  dbSize: string | null
  /** Oldest and newest snapshot timestamps observed (data coverage window). */
  oldestSnapshot: string | null
  newestSnapshot: string | null
}

// The RLS-enabled table builders don't unify under a single generic, so the
// table column is intentionally loose; every entry is one of our own pgTables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLES: { name: string; table: any }[] = [
  { name: 'vehicle', table: vehicle },
  { name: 'vehicle_snapshot', table: vehicleSnapshot },
  { name: 'charge_session', table: chargeSession },
  { name: 'drive_session', table: driveSession },
  { name: 'vehicle_state', table: vehicleState },
  { name: 'software_update', table: softwareUpdate },
  { name: 'geofence', table: geofence },
  { name: 'address', table: address },
]

export const getDbInfo = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<DbInfo> =>
    withDb(async (db: Db) => {
      const userId = context.userId

      const tables: { name: string; rows: number }[] = []
      for (const t of TABLES) {
        const [row] = await db
          .select({ n: count() })
          .from(t.table)
          .where(eq(t.table.user_id, userId))
        tables.push({ name: t.name, rows: Number(row?.n ?? 0) })
      }

      let dbSize: string | null = null
      try {
        const res = (await db.execute(
          sql`select pg_size_pretty(pg_database_size(current_database())) as size`,
        )) as unknown as Array<{ size: string }>
        dbSize = res[0]?.size ?? null
      } catch {
        dbSize = null
      }

      const [span] = await db
        .select({
          oldest: sql<string | null>`min(${vehicleSnapshot.recorded_at})`,
          newest: sql<string | null>`max(${vehicleSnapshot.recorded_at})`,
        })
        .from(vehicleSnapshot)
        .where(eq(vehicleSnapshot.user_id, userId))

      return {
        tables,
        dbSize,
        oldestSnapshot: span?.oldest ?? null,
        newestSnapshot: span?.newest ?? null,
      }
    }),
  )
