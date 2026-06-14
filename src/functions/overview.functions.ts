/**
 * Dashboard overview: link status, vehicles with their latest snapshot, and
 * headline counts. Reads only from Postgres (via Drizzle).
 */
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { vinFilter } from './vin'
import {
  anomalyFlag,
  chargeSession,
  driveSession,
  teslaAccount,
  vehicle,
  vehicleSnapshot,
} from '../server/schema'
import type { Vehicle, VehicleSnapshot } from '../types/db'

export interface VehicleWithLatest {
  vehicle: Vehicle
  latest: VehicleSnapshot | null
}

export interface OverviewPayload {
  linked: boolean
  region: string | null
  vehicles: VehicleWithLatest[]
  counts: { snapshots: number; drives: number; charges: number }
  openAnomalyCount: number
}

export const getOverview = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<OverviewPayload> => {
    const db = getDb()
    const userId = context.userId
    const vin = data?.vin

    const [accountRows, vehicles] = await Promise.all([
      db
        .select({ region: teslaAccount.region })
        .from(teslaAccount)
        .where(eq(teslaAccount.user_id, userId))
        .limit(1),
      db
        .select()
        .from(vehicle)
        .where(eq(vehicle.user_id, userId))
        .orderBy(vehicle.created_at),
    ])
    const account = accountRows[0] ?? null

    const withLatest: VehicleWithLatest[] = []
    for (const v of vehicles as Vehicle[]) {
      const snap = await db
        .select()
        .from(vehicleSnapshot)
        .where(and(eq(vehicleSnapshot.user_id, userId), eq(vehicleSnapshot.vin, v.vin)))
        .orderBy(desc(vehicleSnapshot.recorded_at))
        .limit(1)
      withLatest.push({ vehicle: v, latest: (snap[0] as VehicleSnapshot) ?? null })
    }

    const [snapCount, driveCount, chargeCount, anomalyRows] = await Promise.all([
      countRows(db, vehicleSnapshot, userId, vin),
      countRows(db, driveSession, userId, vin),
      countRows(db, chargeSession, userId, vin),
      db
        .select({ value: count() })
        .from(anomalyFlag)
        .where(
          and(
            eq(anomalyFlag.user_id, userId),
            isNull(anomalyFlag.dismissed_at),
            vin ? eq(anomalyFlag.vin, vin) : undefined,
          ),
        ),
    ])

    return {
      linked: vehicles.length > 0 || !!account,
      region: account?.region ?? null,
      vehicles: withLatest,
      counts: { snapshots: snapCount, drives: driveCount, charges: chargeCount },
      openAnomalyCount: anomalyRows[0]?.value ?? 0,
    }
  })

async function countRows(
  db: ReturnType<typeof getDb>,
  table: typeof vehicleSnapshot | typeof driveSession | typeof chargeSession,
  userId: string,
  vin: string | undefined,
): Promise<number> {
  const where: SQL | undefined = vin
    ? and(eq(table.user_id, userId), eq(table.vin, vin))
    : eq(table.user_id, userId)
  const rows = await db.select({ value: count() }).from(table).where(where)
  return rows[0]?.value ?? 0
}
