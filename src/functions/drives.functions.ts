/**
 * Drive records for the dashboard. Built by the poller from vehicle_data
 * snapshots (the Fleet API has no native trip endpoint), read here from Postgres.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { driveSession, vehicleSnapshot } from '../server/schema'
import type { DriveSession } from '../types/db'

export interface DriveStats {
  driveCount: number
  totalMiles: number
  totalEnergyKwh: number
  avgWhPerMi: number | null
}

export interface DrivesPayload {
  drives: DriveSession[]
  stats: DriveStats
}

export const getDrives = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<DrivesPayload> => {
    const db = getDb()
    const rows = await db
      .select()
      .from(driveSession)
      .where(and(eq(driveSession.user_id, context.userId), isNotNull(driveSession.ended_at)))
      .orderBy(desc(driveSession.started_at))
      .limit(500)

    const drives = rows as DriveSession[]
    let totalMiles = 0
    let totalEnergyKwh = 0
    for (const d of drives) {
      totalMiles += d.distance_mi ?? 0
      totalEnergyKwh += d.energy_used_kwh ?? 0
    }
    const avgWhPerMi = totalMiles > 0 ? Math.round((totalEnergyKwh * 1000) / totalMiles) : null
    return {
      drives,
      stats: {
        driveCount: drives.length,
        totalMiles: Math.round(totalMiles * 10) / 10,
        totalEnergyKwh: Math.round(totalEnergyKwh * 100) / 100,
        avgWhPerMi,
      },
    }
  })

export interface DriveRoute {
  /** Ordered [lat, lng] breadcrumb sampled by the poller during the drive. */
  points: [number, number][]
  /** Whether the points are a real GPS trail (≥2 sampled snapshots) vs just endpoints. */
  sampled: boolean
}

/**
 * Reconstruct a drive's route from the GPS points the poller stored during it.
 * The Fleet API has no trip/route endpoint, so this is the ordered, non-null
 * `vehicle_snapshot` lat/lng within the drive window — a coarse breadcrumb at the
 * poll cadence, not a road-matched line. Falls back to the drive's start/end
 * coords when fewer than two snapshots carried a fix. Scoped to the user's rows.
 */
export const getDriveRoute = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ driveId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<DriveRoute> => {
    const db = getDb()
    const userId = context.userId

    const rows = await db
      .select()
      .from(driveSession)
      .where(and(eq(driveSession.id, data.driveId), eq(driveSession.user_id, userId)))
      .limit(1)
    const drive = rows[0] as DriveSession | undefined
    if (!drive) return { points: [], sampled: false }

    const snaps = await db
      .select({ lat: vehicleSnapshot.latitude, lng: vehicleSnapshot.longitude })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, drive.vin),
          isNotNull(vehicleSnapshot.latitude),
          gte(vehicleSnapshot.recorded_at, drive.started_at),
          lte(vehicleSnapshot.recorded_at, drive.ended_at ?? drive.started_at),
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))

    const points = snaps
      .filter((s): s is { lat: number; lng: number } => s.lat != null && s.lng != null)
      .map((s) => [s.lat, s.lng] as [number, number])

    if (points.length >= 2) return { points, sampled: true }

    // Fallback: whatever endpoints the drive row carries.
    const ends: [number, number][] = []
    if (drive.start_lat != null && drive.start_lng != null) ends.push([drive.start_lat, drive.start_lng])
    if (drive.end_lat != null && drive.end_lng != null) ends.push([drive.end_lat, drive.end_lng])
    return { points: ends, sampled: false }
  })
