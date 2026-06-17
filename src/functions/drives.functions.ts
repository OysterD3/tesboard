/**
 * Drive records for the dashboard. Built by the poller from vehicle_data
 * snapshots (the Fleet API has no native trip endpoint), read here from Postgres.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vinFilter, type VinFilter } from './vin'
import { address, driveSession, geofence, vehicleSnapshot } from '../server/schema'
import { addressLabel } from '../server/geo'
import type { DriveSession } from '../types/db'

/** A drive row augmented with resolved start/end place names (geofence > address). */
export type DriveWithLocation = DriveSession & {
  startLocation: string | null
  endLocation: string | null
}

export interface DriveStats {
  driveCount: number
  totalMiles: number
  totalEnergyKwh: number
  avgWhPerMi: number | null
}

export interface DrivesPayload {
  drives: DriveWithLocation[]
  stats: DriveStats
}

export const getDrives = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<DrivesPayload> =>
    withDb((db) => getDrivesCore(db, context.userId, data)),
  )

export async function getDrivesCore(
  db: Db,
  userId: string,
  data: VinFilter,
): Promise<DrivesPayload> {
    const vin = data?.vin
    const rows = await db
      .select()
      .from(driveSession)
      .where(
        and(
          eq(driveSession.user_id, userId),
          isNotNull(driveSession.ended_at),
          vin ? eq(driveSession.vin, vin) : undefined,
        ),
      )
      .orderBy(desc(driveSession.started_at))
      .limit(500)

    const baseDrives = rows as DriveSession[]

    // Resolve place names for the start/end of each drive. A named geofence (Home,
    // Work) wins over the reverse-geocoded street address. Both lookups are scoped
    // to the user's own rows and batched by id.
    const addrIds = [
      ...new Set(
        baseDrives.flatMap((d) => [d.start_address_id, d.end_address_id]).filter((x): x is number => x != null),
      ),
    ]
    const geoIds = [
      ...new Set(
        baseDrives.flatMap((d) => [d.start_geofence_id, d.end_geofence_id]).filter((x): x is number => x != null),
      ),
    ]

    const addrRows = addrIds.length
      ? await db
          .select({
            id: address.id,
            name: address.name,
            road: address.road,
            neighbourhood: address.neighbourhood,
            city: address.city,
            display_name: address.display_name,
          })
          .from(address)
          .where(and(eq(address.user_id, userId), inArray(address.id, addrIds)))
      : []
    const geoRows = geoIds.length
      ? await db
          .select({ id: geofence.id, name: geofence.name })
          .from(geofence)
          .where(and(eq(geofence.user_id, userId), inArray(geofence.id, geoIds)))
      : []

    const addrMap = new Map(addrRows.map((a) => [a.id, a]))
    const geoMap = new Map(geoRows.map((g) => [g.id, g.name]))
    const placeFor = (addrId: number | null, geoId: number | null): string | null => {
      if (geoId != null) {
        const g = geoMap.get(geoId)
        if (g) return g
      }
      const a = addrId != null ? addrMap.get(addrId) : undefined
      return a ? addressLabel(a) : null
    }

    const drives: DriveWithLocation[] = baseDrives.map((d) => ({
      ...d,
      startLocation: placeFor(d.start_address_id, d.start_geofence_id),
      endLocation: placeFor(d.end_address_id, d.end_geofence_id),
    }))

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
}

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
  .handler(async ({ data, context }): Promise<DriveRoute> =>
    withDb(async (db) => {
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
  }))
