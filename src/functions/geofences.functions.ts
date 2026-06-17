/**
 * Named geofences with per-zone billing. Generalizes the single home geofence on
 * electricity_rate. Every fn carries authMiddleware and scopes by user_id.
 *
 * The Home zone is kept in sync with electricity_rate.home_* via `seedHomeGeofence`
 * so the existing home-cost behaviour (and the Settings "home location" picker)
 * keep working while charges can now match any named zone.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { electricityRate, geofence } from '../server/schema'
import type { Geofence } from '../types/db'

export const getGeofences = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Geofence[]> =>
    withDb((db) => getGeofencesCore(db, context.userId)),
  )

export async function getGeofencesCore(db: Db, userId: string): Promise<Geofence[]> {
    return (await db
      .select()
      .from(geofence)
      .where(eq(geofence.user_id, userId))
      .orderBy(asc(geofence.name))) as Geofence[]
}

const geofenceInput = z.object({
  id: z.number().int().positive().nullable().optional(),
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().positive().max(20000).default(150),
  billingType: z.enum(['per_kwh', 'per_minute', 'per_session']).default('per_kwh'),
  costPerUnit: z.number().nonnegative().nullable().optional(),
  sessionFee: z.number().nonnegative().nullable().optional(),
  currency: z.string().min(1).max(8).nullable().optional(),
  isHome: z.boolean().default(false),
})

export const upsertGeofence = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(geofenceInput)
  .handler(async ({ data, context }): Promise<Geofence> =>
    withDb(async (db) => {
    const userId = context.userId
    const values = {
      user_id: userId,
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      radius_m: data.radiusM,
      billing_type: data.billingType,
      cost_per_unit: data.costPerUnit ?? null,
      session_fee: data.sessionFee ?? null,
      currency: data.currency ?? null,
      is_home: data.isHome,
      updated_at: new Date().toISOString(),
    }

    let row: Geofence
    if (data.id != null) {
      const rows = await db
        .update(geofence)
        .set(values)
        .where(and(eq(geofence.id, data.id), eq(geofence.user_id, userId)))
        .returning()
      row = rows[0] as Geofence
    } else {
      const rows = await db.insert(geofence).values(values).returning()
      row = rows[0] as Geofence
    }

    // Keep electricity_rate.home_* in sync with the designated home zone so the
    // poller's home classification + the readiness card stay correct.
    if (data.isHome) {
      await db
        .update(geofence)
        .set({ is_home: false })
        .where(and(eq(geofence.user_id, userId), eq(geofence.is_home, true)))
      await db
        .update(geofence)
        .set({ is_home: true })
        .where(and(eq(geofence.id, row.id), eq(geofence.user_id, userId)))
      await db
        .insert(electricityRate)
        .values({
          user_id: userId,
          home_lat: data.lat,
          home_lng: data.lng,
          home_radius_m: data.radiusM,
          updated_at: values.updated_at,
        })
        .onConflictDoUpdate({
          target: electricityRate.user_id,
          set: { home_lat: data.lat, home_lng: data.lng, home_radius_m: data.radiusM },
        })
    }
    return row
  }))

export const deleteGeofence = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<{ deleted: number }> =>
    withDb(async (db) => {
    const res = await db
      .delete(geofence)
      .where(and(eq(geofence.id, data.id), eq(geofence.user_id, context.userId)))
    return { deleted: (res as { count?: number }).count ?? 0 }
  }))

/**
 * Ensure a "Home" geofence row exists mirroring electricity_rate.home_*. Called
 * lazily so existing single-geofence users transparently gain a Home zone.
 */
export const seedHomeGeofence = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Geofence | null> =>
    withDb(async (db) => {
    const userId = context.userId
    const [rate] = await db
      .select()
      .from(electricityRate)
      .where(eq(electricityRate.user_id, userId))
      .limit(1)
    if (!rate || rate.home_lat == null || rate.home_lng == null) return null
    const [existingHome] = await db
      .select()
      .from(geofence)
      .where(and(eq(geofence.user_id, userId), eq(geofence.is_home, true)))
      .limit(1)
    if (existingHome) return existingHome as Geofence
    const rows = await db
      .insert(geofence)
      .values({
        user_id: userId,
        name: 'Home',
        lat: rate.home_lat,
        lng: rate.home_lng,
        radius_m: rate.home_radius_m ?? 150,
        billing_type: 'per_kwh',
        cost_per_unit: rate.flat_rate,
        currency: rate.currency,
        is_home: true,
      })
      .onConflictDoNothing()
      .returning()
    return (rows[0] as Geofence) ?? null
  }))
