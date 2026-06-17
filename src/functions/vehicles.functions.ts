/**
 * Vehicle list for the multi-vehicle switcher + per-vehicle metadata. Read-only;
 * authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { asc, eq } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { vehicle } from '../server/schema'
import type { Vehicle } from '../types/db'

export const getVehicles = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Vehicle[]> =>
    withDb(async (db) => {
    return (await db
      .select()
      .from(vehicle)
      .where(eq(vehicle.user_id, context.userId))
      .orderBy(asc(vehicle.display_priority), asc(vehicle.display_name))) as Vehicle[]
  }))
