/**
 * Vehicle state timeline (online/asleep/offline) + time-in-state aggregation,
 * and firmware-update history. Read-only; authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { softwareUpdate, vehicleState } from '../server/schema'
import type { SoftwareUpdate, VehicleState } from '../types/db'

const input = z.object({ vin: z.string().optional(), days: z.number().int().min(1).max(365).default(30) })
export type StatesInput = z.infer<typeof input>

export interface StatesResult {
  intervals: VehicleState[]
  timeInState: { state: string; seconds: number; pct: number }[]
}

export const getStates = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }): Promise<StatesResult> =>
    withDb((db) => getStatesCore(db, context.userId, data)),
  )

export async function getStatesCore(
  db: Db,
  userId: string,
  data: StatesInput,
): Promise<StatesResult> {
    const since = new Date(Date.now() - data.days * 86400_000).toISOString()
    const intervals = (await db
      .select()
      .from(vehicleState)
      .where(
        and(
          eq(vehicleState.user_id, userId),
          data.vin ? eq(vehicleState.vin, data.vin) : undefined,
          gte(vehicleState.started_at, since),
        ),
      )
      .orderBy(desc(vehicleState.started_at))) as VehicleState[]

    const totals = new Map<string, number>()
    for (const iv of intervals) {
      const end = iv.ended_at ? new Date(iv.ended_at).getTime() : Date.now()
      const secs = Math.max(0, (end - new Date(iv.started_at).getTime()) / 1000)
      totals.set(iv.state, (totals.get(iv.state) ?? 0) + secs)
    }
    const grand = [...totals.values()].reduce((a, b) => a + b, 0) || 1
    const timeInState = [...totals.entries()]
      .map(([state, seconds]) => ({ state, seconds, pct: (seconds / grand) * 100 }))
      .sort((a, b) => b.seconds - a.seconds)

    return { intervals, timeInState }
}

export const getSoftwareUpdates = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ vin: z.string().optional() }))
  .handler(async ({ data, context }): Promise<SoftwareUpdate[]> =>
    withDb(async (db) => {
    return (await db
      .select()
      .from(softwareUpdate)
      .where(
        and(
          eq(softwareUpdate.user_id, context.userId),
          data?.vin ? eq(softwareUpdate.vin, data.vin) : undefined,
        ),
      )
      .orderBy(desc(softwareUpdate.started_at))) as SoftwareUpdate[]
  }))
