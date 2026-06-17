/**
 * Reconcile Tesla's authoritative Supercharger billing (/dx/charging/history)
 * with local charge sessions. Matches by time proximity; if no local session
 * exists (e.g. charge happened before the poller ran), inserts a standalone
 * billed session so historical Supercharger spend still shows up.
 */
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm'
import { withDb, type Db } from './db'
import { chargeSession, vehicle } from './schema'
import { ASLEEP, createTeslaClient, getChargingHistory } from './tesla/client.server'
import type { TeslaChargingHistoryRecord } from './tesla/types'

const MATCH_WINDOW_MS = 30 * 60 * 1000 // ±30 min between billed start and local session

export interface ReconcileSummary {
  imported: number
  matched: number
  inserted: number
  errors: string[]
}

export async function reconcileAllUsers(maxPages = 5): Promise<ReconcileSummary> {
  return withDb(async (db) => {
  const summary: ReconcileSummary = { imported: 0, matched: 0, inserted: 0, errors: [] }
  const vehicles = await db
    .select({ vin: vehicle.vin, user_id: vehicle.user_id })
    .from(vehicle)

  for (const v of vehicles) {
    try {
      const ctx = await createTeslaClient(db, v.user_id)
      for (let page = 1; page <= maxPages; page++) {
        const records = await getChargingHistory(ctx, { vin: v.vin, pageNo: page, pageSize: 50 })
        if (records === ASLEEP) {
          // Transient 408 — don't treat as "no data" / clean success. Skip this cycle.
          summary.errors.push(`vin ${v.vin}: charging history unavailable (408), skipped`)
          break
        }
        if (!records.length) break
        for (const rec of records) {
          summary.imported++
          await reconcileRecord(db, v.user_id, v.vin, rec, summary)
        }
        if (records.length < 50) break
      }
    } catch (e) {
      summary.errors.push(`vin ${v.vin}: ${(e as Error).message}`)
    }
  }
  return summary
  })
}

function billedTotals(rec: TeslaChargingHistoryRecord) {
  const fees = rec.fees ?? []
  const hasFees = fees.length > 0
  let cost = 0
  let energy = 0
  let currency: string | null = null
  for (const fee of fees) {
    if (fee.totalDue) cost += fee.totalDue
    if (fee.currencyCode) currency = fee.currencyCode
    if (fee.uom === 'kWh' && fee.usageBase) energy += fee.usageBase
  }
  return { cost, energy, currency, hasFees }
}

async function reconcileRecord(
  db: Db,
  userId: string,
  vin: string,
  rec: TeslaChargingHistoryRecord,
  summary: ReconcileSummary,
): Promise<void> {
  const startedAt = rec.chargeStartDateTime ? new Date(rec.chargeStartDateTime) : null
  if (!startedAt || Number.isNaN(startedAt.getTime())) return
  const { cost, energy, currency, hasFees } = billedTotals(rec)
  const teslaId = rec.sessionId != null ? String(rec.sessionId) : null

  // Already imported?
  if (teslaId) {
    const existing = await db
      .select({ id: chargeSession.id })
      .from(chargeSession)
      .where(
        and(
          eq(chargeSession.user_id, userId),
          eq(chargeSession.tesla_charge_session_id, teslaId),
        ),
      )
      .limit(1)
    if (existing.length) return
  }

  // Try to match an existing local session by start-time proximity.
  const lo = new Date(startedAt.getTime() - MATCH_WINDOW_MS).toISOString()
  const hi = new Date(startedAt.getTime() + MATCH_WINDOW_MS).toISOString()
  const candidates = await db
    .select({ id: chargeSession.id })
    .from(chargeSession)
    .where(
      and(
        eq(chargeSession.user_id, userId),
        eq(chargeSession.vin, vin),
        isNull(chargeSession.tesla_charge_session_id),
        gte(chargeSession.started_at, lo),
        lte(chargeSession.started_at, hi),
      ),
    )
    .orderBy(asc(chargeSession.started_at))
    .limit(1)
  const candidate = candidates[0] ?? null

  const patch = {
    source: 'supercharger' as const,
    charge_location_type: 'supercharger' as const,
    // Preserve a genuine $0 billed session (free Supercharging); use null only
    // when Tesla returned no fee data at all.
    cost_amount: hasFees ? cost : null,
    cost_currency: currency,
    cost_source: 'tesla_billed' as const,
    tesla_charge_session_id: teslaId,
    location_name: rec.siteLocationName ?? null,
    updated_at: new Date().toISOString(),
  }

  if (candidate) {
    await db
      .update(chargeSession)
      .set(patch)
      .where(and(eq(chargeSession.id, candidate.id), eq(chargeSession.user_id, userId)))
    summary.matched++
  } else {
    await db.insert(chargeSession).values({
      vin,
      user_id: userId,
      started_at: startedAt.toISOString(),
      ended_at: rec.chargeStopDateTime ?? null,
      energy_added_kwh: hasFees ? energy : null,
      ...patch,
    })
    summary.inserted++
  }
}
