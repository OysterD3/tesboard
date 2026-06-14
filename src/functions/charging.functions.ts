/**
 * Charging data for the dashboard. Reads only from Postgres (never the car).
 * RLS via the user-scoped client confines rows to the signed-in user.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { chargeSession, vehicleSnapshot } from '../server/schema'
import type { ChargeSession } from '../types/db'

export interface ChargingStats {
  sessionCount: number
  totalEnergyKwh: number
  totalCost: number
  currency: string | null
  superchargerCost: number
  homeCost: number
  totalMilesAdded: number
  avgCostPerKwh: number | null
  avgCostPerMile: number | null
}

export interface ChargingPayload {
  sessions: ChargeSession[]
  stats: ChargingStats
}

export const getCharging = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ChargingPayload> => {
    const db = getDb()
    const rows = await db
      .select()
      .from(chargeSession)
      .where(eq(chargeSession.user_id, context.userId))
      .orderBy(desc(chargeSession.started_at))
      .limit(500)

    const sessions = rows as ChargeSession[]
    const stats = summarize(sessions)
    return { sessions, stats }
  })

function summarize(sessions: ChargeSession[]): ChargingStats {
  let totalEnergyKwh = 0
  let totalCost = 0
  let superchargerCost = 0
  let homeCost = 0
  let totalMilesAdded = 0
  let currency: string | null = null

  for (const s of sessions) {
    totalEnergyKwh += s.energy_added_kwh ?? 0
    totalMilesAdded += s.miles_added_rated ?? 0
    const cost = s.cost_amount ?? 0
    totalCost += cost
    if (s.cost_currency) currency = s.cost_currency
    if (s.source === 'supercharger') superchargerCost += cost
    else homeCost += cost
  }

  return {
    sessionCount: sessions.length,
    totalEnergyKwh: round(totalEnergyKwh),
    totalCost: round(totalCost),
    currency,
    superchargerCost: round(superchargerCost),
    homeCost: round(homeCost),
    totalMilesAdded: round(totalMilesAdded),
    avgCostPerKwh: totalEnergyKwh > 0 ? round(totalCost / totalEnergyKwh, 4) : null,
    avgCostPerMile: totalMilesAdded > 0 ? round(totalCost / totalMilesAdded, 4) : null,
  }
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export interface ChargeDetail {
  /** Whether any per-snapshot power/SOC was captured during the session. */
  hasData: boolean
  /** Real kW readings over the session window (charger_power per snapshot). */
  curve: number[]
  peakKw: number | null
  soc0: number | null
  soc1: number | null
  /** Minutes from start when SOC first reached 80% / 100% (null if never). */
  hit80: number | null
  hit100: number | null
  /** Minutes spent at ≥80% while still plugged in. */
  minAbove80: number
}

/**
 * Reconstruct a charge session's power curve, peak, SOC range and 80/100% timing
 * from the `vehicle_snapshot` rows captured during it (charger_power + battery_level).
 * The Fleet API gives no per-session curve, so this is the real sampled telemetry
 * at the poll cadence. Scoped to the user's rows.
 */
export const getChargeDetail = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(z.object({ sessionId: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<ChargeDetail> => {
    const db = getDb()
    const userId = context.userId
    const empty: ChargeDetail = { hasData: false, curve: [], peakKw: null, soc0: null, soc1: null, hit80: null, hit100: null, minAbove80: 0 }

    const rows = await db
      .select()
      .from(chargeSession)
      .where(and(eq(chargeSession.id, data.sessionId), eq(chargeSession.user_id, userId)))
      .limit(1)
    const session = rows[0] as ChargeSession | undefined
    if (!session) return empty

    const snaps = await db
      .select({
        power: vehicleSnapshot.charger_power,
        soc: vehicleSnapshot.battery_level,
        at: vehicleSnapshot.recorded_at,
      })
      .from(vehicleSnapshot)
      .where(
        and(
          eq(vehicleSnapshot.user_id, userId),
          eq(vehicleSnapshot.vin, session.vin),
          gte(vehicleSnapshot.recorded_at, session.started_at),
          lte(vehicleSnapshot.recorded_at, session.ended_at ?? new Date().toISOString()),
        ),
      )
      .orderBy(asc(vehicleSnapshot.recorded_at))
    if (snaps.length === 0) return empty

    const startMs = new Date(session.started_at).getTime()
    const minutesAt = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - startMs) / 60000))

    const powers = snaps.map((s) => s.power).filter((p): p is number => p != null && p >= 0)
    const socs = snaps.map((s) => s.soc).filter((s): s is number => s != null)

    let hit80: number | null = null
    let hit100: number | null = null
    let firstAbove80At: number | null = null
    let lastAt = minutesAt(session.ended_at ?? session.started_at)
    for (const s of snaps) {
      const m = minutesAt(s.at)
      lastAt = Math.max(lastAt, m)
      if (s.soc != null) {
        if (hit80 == null && s.soc >= 80) hit80 = m
        if (hit100 == null && s.soc >= 100) hit100 = m
        if (firstAbove80At == null && s.soc >= 80) firstAbove80At = m
      }
    }
    const minAbove80 = firstAbove80At != null ? Math.max(0, lastAt - firstAbove80At) : 0

    return {
      hasData: powers.length > 0 || socs.length > 0,
      curve: downsample(powers, 80),
      peakKw: powers.length ? round(Math.max(...powers), 1) : null,
      soc0: socs.length ? socs[0] : null,
      soc1: socs.length ? socs[socs.length - 1] : null,
      hit80,
      hit100,
      minAbove80,
    }
  })

/** Evenly sample down to at most `max` points so the chart path stays light. */
function downsample(arr: number[], max: number): number[] {
  if (arr.length <= max) return arr
  const step = arr.length / max
  const out: number[] = []
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)])
  return out
}
