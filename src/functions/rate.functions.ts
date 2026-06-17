/**
 * Electricity rate + home-geofence config. The rate powers home-charge cost
 * (Tesla never bills home charging). The home geofence (lat/lng/radius) lets the
 * poller classify each charge as home/away and tightens which charges get the
 * home rate. Also a nightly departure target (%) for the readiness card.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { vinFilter } from './vin'
import { classifyChargeLocation, findGeofence } from '../server/geo'
import { computeChargeCost } from '../server/cost'
import { sumChargeEnergyAdded } from '../lib/analytics-vm'
import { chargeSession, electricityRate, geofence, vehicle, vehicleSnapshot } from '../server/schema'
import type { ChargeSession, ElectricityRate, Geofence } from '../types/db'

export const getRate = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ElectricityRate | null> =>
    withDb((db) => getRateCore(db, context.userId)),
  )

export async function getRateCore(db: Db, userId: string): Promise<ElectricityRate | null> {
    const rows = await db
      .select()
      .from(electricityRate)
      .where(eq(electricityRate.user_id, userId))
      .limit(1)
    return (rows[0] as ElectricityRate) ?? null
}

const rateInput = z
  .object({
    currency: z.string().min(1).max(8).default('USD'),
    flatRate: z.number().nonnegative(),
    lossFactor: z.number().min(1).max(2).default(1.1),
    homeLat: z.number().min(-90).max(90).nullable().optional(),
    homeLng: z.number().min(-180).max(180).nullable().optional(),
    homeRadiusM: z.number().positive().max(5000).nullable().optional(),
    departureTargetSoc: z.number().int().min(0).max(100).nullable().optional(),
  })
  .refine((d) => (d.homeLat == null) === (d.homeLng == null), {
    message: 'home latitude and longitude must be provided together',
  })

export const saveRate = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rateInput)
  .handler(async ({ data, context }): Promise<ElectricityRate> =>
    withDb(async (db) => {
    const values = {
      user_id: context.userId,
      kind: 'flat',
      currency: data.currency,
      flat_rate: data.flatRate,
      loss_factor: data.lossFactor,
      home_lat: data.homeLat ?? null,
      home_lng: data.homeLng ?? null,
      home_radius_m: data.homeLat == null ? null : (data.homeRadiusM ?? 150),
      departure_target_soc: data.departureTargetSoc ?? null,
      updated_at: new Date().toISOString(),
    }
    const rows = await db
      .insert(electricityRate)
      .values(values)
      .onConflictDoUpdate({
        target: electricityRate.user_id,
        set: {
          kind: values.kind,
          currency: values.currency,
          flat_rate: values.flat_rate,
          loss_factor: values.loss_factor,
          home_lat: values.home_lat,
          home_lng: values.home_lng,
          home_radius_m: values.home_radius_m,
          departure_target_soc: values.departure_target_soc,
          updated_at: values.updated_at,
        },
      })
      .returning()
    return rows[0] as ElectricityRate
  }))

/** Newest stored GPS fix — used by Settings to one-click prefill the home location. */
export const getLatestVehicleGps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(
    async ({
      data,
      context,
    }): Promise<{ lat: number; lng: number; recorded_at: string } | null> =>
      withDb(async (db) => {
      const vin = data?.vin
      const rows = await db
        .select({
          lat: vehicleSnapshot.latitude,
          lng: vehicleSnapshot.longitude,
          recorded_at: vehicleSnapshot.recorded_at,
        })
        .from(vehicleSnapshot)
        .where(
          and(
            eq(vehicleSnapshot.user_id, context.userId),
            isNotNull(vehicleSnapshot.latitude),
            vin ? eq(vehicleSnapshot.vin, vin) : undefined,
          ),
        )
        .orderBy(desc(vehicleSnapshot.recorded_at))
        .limit(1)
      const r = rows[0]
      return r && r.lat != null && r.lng != null
        ? { lat: r.lat, lng: r.lng, recorded_at: r.recorded_at }
        : null
    }),
  )

/**
 * Reclassify existing closed charge sessions against the (new) home geofence and
 * recompute home cost where the verdict changed. NEVER touches tesla_billed rows
 * (authoritative Supercharger billing). No-op if the home location is unset.
 */
export const reclassifyCharges = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ reclassified: number; recosted: number }> =>
    withDb(async (db) => {
    const userId = context.userId
    const rateRows = await db
      .select()
      .from(electricityRate)
      .where(eq(electricityRate.user_id, userId))
      .limit(1)
    const rate = rateRows[0] as ElectricityRate | undefined
    const geofences = (await db
      .select()
      .from(geofence)
      .where(eq(geofence.user_id, userId))) as Geofence[]
    const homeConfigured = rate?.home_lat != null && rate?.home_lng != null
    if (!homeConfigured && geofences.length === 0) {
      return { reclassified: 0, recosted: 0 }
    }
    const freeVins = new Set(
      (
        await db
          .select({ vin: vehicle.vin })
          .from(vehicle)
          .where(and(eq(vehicle.user_id, userId), eq(vehicle.free_supercharging, true)))
      ).map((v) => v.vin),
    )

    const sessions = (await db
      .select()
      .from(chargeSession)
      .where(and(eq(chargeSession.user_id, userId), isNotNull(chargeSession.ended_at)))) as ChargeSession[]

    // Authoritative / imported costs are never rewritten.
    const FROZEN = new Set(['tesla_billed', 'tesla_billed_free', 'imported_teslamate'])

    let reclassified = 0
    let recosted = 0
    for (const s of sessions) {
      const gf = findGeofence(s.lat, s.lng, geofences)
      const type =
        s.source === 'supercharger'
          ? 'supercharger'
          : gf
            ? gf.is_home
              ? 'home'
              : 'away'
            : classifyChargeLocation(s.source, s.lat, s.lng, rate ?? null)
      const set: Record<string, unknown> = {}
      let typeChanged = false
      let costChanged = false

      if (type !== s.charge_location_type) {
        set.charge_location_type = type
        typeChanged = true
      }
      const newGid = gf?.id ?? null
      if (newGid !== s.geofence_id) set.geofence_id = newGid

      if (!FROZEN.has(s.cost_source)) {
        const durationS =
          s.ended_at != null
            ? Math.max(0, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000))
            : null
        const costR = computeChargeCost({
          source: s.source,
          freeSupercharging: freeVins.has(s.vin),
          energyAddedKwh: s.energy_added_kwh,
          energyUsedKwh: s.energy_used_kwh,
          durationS,
          geofence: gf
            ? {
                billing_type: gf.billing_type,
                cost_per_unit: gf.cost_per_unit,
                session_fee: gf.session_fee,
                currency: gf.currency,
                is_home: gf.is_home,
              }
            : null,
          homeRate: rate
            ? { flat_rate: rate.flat_rate, loss_factor: rate.loss_factor, currency: rate.currency }
            : null,
          isHome: type === 'home',
        })
        if (
          s.cost_amount !== costR.cost_amount ||
          s.rate_applied !== costR.rate_applied ||
          s.cost_currency !== costR.cost_currency
        ) {
          set.cost_amount = costR.cost_amount
          set.cost_currency = costR.cost_currency
          set.rate_applied = costR.rate_applied
          if (costR.cost_source === 'geofence') set.cost_source = 'geofence'
          costChanged = true
        }
      }

      if (Object.keys(set).length > 0) {
        set.updated_at = new Date().toISOString()
        await db
          .update(chargeSession)
          .set(set)
          .where(and(eq(chargeSession.id, s.id), eq(chargeSession.user_id, userId)))
        if (typeChanged) reclassified++
        if (costChanged) recosted++
      }
    }
    return { reclassified, recosted }
  }))

/**
 * One-time repair: re-derive each computed charge session's `energy_added_kwh`
 * from its `vehicle_snapshot` charge_energy_added readings using the fixed
 * reset-aware summation (the old summation re-banked the running peak on sample
 * noise, inflating sessions to impossible kWh — e.g. 193 kWh on AC), clamp to the
 * pack size, and recompute home cost from the corrected energy. NEVER touches
 * authoritative/imported costs, and skips sessions with no snapshot energy
 * (imports, pre-poller history) so it can't zero out a legitimate value.
 */
export const repairChargeEnergy = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ scanned: number; repaired: number }> =>
    withDb(async (db) => {
      const userId = context.userId
      const rate = await getRateCore(db, userId)
      const geofences = (await db
        .select()
        .from(geofence)
        .where(eq(geofence.user_id, userId))) as Geofence[]
      const vehRows = await db
        .select({ vin: vehicle.vin, pack_kwh: vehicle.pack_kwh, free: vehicle.free_supercharging })
        .from(vehicle)
        .where(eq(vehicle.user_id, userId))
      const packByVin = new Map(vehRows.map((v) => [v.vin, v.pack_kwh]))
      const freeVins = new Set(vehRows.filter((v) => v.free).map((v) => v.vin))

      // Only computed/geofence home costs are recomputable; Tesla-billed + imports stay frozen.
      const sessions = (await db
        .select()
        .from(chargeSession)
        .where(and(eq(chargeSession.user_id, userId), isNotNull(chargeSession.ended_at)))) as ChargeSession[]
      const FROZEN = new Set(['tesla_billed', 'tesla_billed_free', 'imported_teslamate'])

      let scanned = 0
      let repaired = 0
      for (const s of sessions) {
        if (FROZEN.has(s.cost_source)) continue
        scanned++

        const snaps = await db
          .select({ e: vehicleSnapshot.charge_energy_added })
          .from(vehicleSnapshot)
          .where(
            and(
              eq(vehicleSnapshot.user_id, userId),
              eq(vehicleSnapshot.vin, s.vin),
              gte(vehicleSnapshot.recorded_at, s.started_at),
              lte(vehicleSnapshot.recorded_at, s.ended_at ?? s.started_at),
            ),
          )
          .orderBy(asc(vehicleSnapshot.recorded_at))
        const energies = snaps.map((r) => r.e).filter((n): n is number => n != null)
        let newEnergy = sumChargeEnergyAdded(energies)
        if (newEnergy == null) continue // no snapshot energy — leave as-is

        const pack = packByVin.get(s.vin)
        if (pack != null && pack > 0 && newEnergy > pack) newEnergy = pack

        const round2 = (n: number) => Math.round(n * 100) / 100
        newEnergy = round2(newEnergy)
        const energyChanged = s.energy_added_kwh == null || round2(s.energy_added_kwh) !== newEnergy
        if (!energyChanged) continue

        const gf = findGeofence(s.lat, s.lng, geofences)
        const type =
          s.source === 'supercharger'
            ? 'supercharger'
            : gf
              ? gf.is_home
                ? 'home'
                : 'away'
              : classifyChargeLocation(s.source, s.lat, s.lng, rate ?? null)
        const durationS =
          s.ended_at != null
            ? Math.max(0, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000))
            : null
        const costR = computeChargeCost({
          source: s.source,
          freeSupercharging: freeVins.has(s.vin),
          energyAddedKwh: newEnergy,
          energyUsedKwh: s.energy_used_kwh,
          durationS,
          geofence: gf
            ? {
                billing_type: gf.billing_type,
                cost_per_unit: gf.cost_per_unit,
                session_fee: gf.session_fee,
                currency: gf.currency,
                is_home: gf.is_home,
              }
            : null,
          homeRate: rate
            ? { flat_rate: rate.flat_rate, loss_factor: rate.loss_factor, currency: rate.currency }
            : null,
          isHome: type === 'home',
        })

        await db
          .update(chargeSession)
          .set({
            energy_added_kwh: newEnergy,
            cost_amount: costR.cost_amount,
            cost_currency: costR.cost_currency,
            rate_applied: costR.rate_applied,
            updated_at: new Date().toISOString(),
          })
          .where(and(eq(chargeSession.id, s.id), eq(chargeSession.user_id, userId)))
        repaired++
      }
      return { scanned, repaired }
    }),
  )
