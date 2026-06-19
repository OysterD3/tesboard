/**
 * Merge fragmented charge sessions into one row per physical plug-in — the
 * server/cron counterpart of the `pnpm merge:charges` CLI. Stop/start charging
 * (unplug/replug to reset an AC charger) records one plug-in as several
 * charge_session rows; this collapses each run of fragments into its earliest row
 * (the SURVIVOR), repoints vehicle_snapshot.source_charge_id to it, and deletes the
 * absorbed rows (anomaly_flag cascades).
 *
 * Sessions sharing a QuickCharge receipt number (invoices.quickcharge.receiptNo)
 * always merge (authoritative plug-in boundary); other adjacent fragments merge
 * only within `gapMs`. Each plug-in is merged in its own transaction so a partial
 * failure can't double-count on the next run. Idempotent: a survivor re-clustered
 * later stands alone, so re-runs (every hour) are no-ops.
 *
 * The pure clustering/field math below is the canonical copy; scripts/charges/
 * merge.mjs mirrors it for the CLI — keep the two in sync (the .mjs can't import
 * this .ts, same constraint as src/server/cost.ts and the per-importer convert.mjs).
 */
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { withDb, type Db } from './db'
import { chargeSession, vehicleSnapshot } from './schema'

export const DEFAULT_GAP_MS = 60_000 // 1 minute

export interface MergeSession {
  id: number
  user_id: string
  vin: string
  source: string
  started_at: string
  ended_at: string | null
  energy_added_kwh: number | null
  energy_used_kwh: number | null
  cost_amount: number | null
  cost_currency: string | null
  cost_source: string
  rate_applied: number | null
  miles_added_rated: number | null
  start_range_mi: number | null
  end_range_mi: number | null
  start_battery_level: number | null
  end_battery_level: number | null
  outside_temp_avg: number | null
  geofence_id: number | null
  invoices: unknown
}

/** The exact columns the survivor row is patched with (no id/vin/invoices/etc.). */
export interface MergePatch {
  ended_at: string | null
  energy_added_kwh: number | null
  energy_used_kwh: number | null
  cost_amount: number | null
  cost_currency: string | null
  cost_source: string
  rate_applied: number | null
  miles_added_rated: number | null
  start_battery_level: number | null
  end_battery_level: number | null
  start_range_mi: number | null
  end_range_mi: number | null
  outside_temp_avg: number | null
  geofence_id: number | null
}

export interface MergePlan {
  survivorId: number
  userId: string
  absorbedIds: number[]
  set: MergePatch
}

export interface MergeSummary {
  scanned: number
  merged: number
  deleted: number
  repointed: number
  errors: string[]
}

// ── pure: clustering + field math (mirror of scripts/charges/merge.mjs) ──────

/** QuickCharge receipt number on a session, or null. */
export function receiptOf(s: MergeSession): string | null {
  const inv = s.invoices as { quickcharge?: { receiptNo?: unknown } } | null
  if (inv && typeof inv === 'object' && inv.quickcharge && inv.quickcharge.receiptNo != null) {
    return String(inv.quickcharge.receiptNo)
  }
  return null
}

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN)
const sum = (arr: (number | null)[]) => {
  const v = arr.filter((x): x is number => x != null && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) : null
}
const mean = (arr: (number | null)[]) => {
  const v = arr.filter((x): x is number => x != null && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const round = (n: number | null, dp: number) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp)

const COST_RANK = ['computed', 'geofence', 'imported_teslamate', 'manual', 'tesla_billed_free', 'tesla_billed', 'quickcharge']

/** Cluster sorted-by-started_at sessions into physical plug-ins. */
export function clusterSessions(sessions: MergeSession[], gapMs: number): MergeSession[][] {
  const sorted = [...sessions].sort((a, b) => ms(a.started_at) - ms(b.started_at))
  const clusters: MergeSession[][] = []
  let cur: MergeSession[] | null = null
  let curMaxEnd = -Infinity
  for (const s of sorted) {
    if (!cur) {
      cur = [s]
      curMaxEnd = ms(s.ended_at)
      continue
    }
    const prev = cur[cur.length - 1]
    const rPrev = receiptOf(prev)
    const rS = receiptOf(s)
    const sameReceipt = rPrev != null && rS != null && rPrev === rS
    const diffReceipt = rPrev != null && rS != null && rPrev !== rS
    const gap = ms(s.started_at) - curMaxEnd
    const contiguous = Number.isFinite(gap) && gap <= gapMs
    if (s.source === prev.source && !diffReceipt && (sameReceipt || contiguous)) {
      cur.push(s)
      if (ms(s.ended_at) > curMaxEnd) curMaxEnd = ms(s.ended_at)
    } else {
      clusters.push(cur)
      cur = [s]
      curMaxEnd = ms(s.ended_at)
    }
  }
  if (cur) clusters.push(cur)
  return clusters
}

/** Compute the merged survivor patch for a multi-session cluster (>= 2). */
export function mergeCluster(cluster: MergeSession[]): MergePlan {
  const byStart = [...cluster].sort((a, b) => ms(a.started_at) - ms(b.started_at))
  const survivor = byStart[0]
  const last = [...cluster].sort((a, b) => ms(a.ended_at) - ms(b.ended_at))[cluster.length - 1]

  const energyUsed = sum(cluster.map((s) => s.energy_used_kwh))
  const cost = sum(cluster.map((s) => s.cost_amount))
  const milesAdded =
    survivor.start_range_mi != null && last.end_range_mi != null
      ? round(last.end_range_mi - survivor.start_range_mi, 4)
      : sum(cluster.map((s) => s.miles_added_rated))
  const costSource = COST_RANK.filter((r) => cluster.some((s) => s.cost_source === r)).pop() ?? survivor.cost_source
  const currency = cluster.map((s) => s.cost_currency).find((c) => c != null) ?? null
  const geofenceId = cluster.map((s) => s.geofence_id).find((g) => g != null) ?? null
  const rateApplied = cost != null && energyUsed && energyUsed > 0 ? round(cost / energyUsed, 6) : survivor.rate_applied

  return {
    survivorId: survivor.id,
    userId: survivor.user_id,
    absorbedIds: byStart.slice(1).map((s) => s.id),
    set: {
      ended_at: last.ended_at,
      energy_added_kwh: sum(cluster.map((s) => s.energy_added_kwh)),
      energy_used_kwh: energyUsed,
      cost_amount: cost == null ? null : round(cost, 4),
      cost_currency: currency,
      cost_source: costSource,
      rate_applied: rateApplied,
      miles_added_rated: milesAdded,
      start_battery_level: survivor.start_battery_level,
      end_battery_level: last.end_battery_level,
      start_range_mi: survivor.start_range_mi,
      end_range_mi: last.end_range_mi,
      outside_temp_avg: round(mean(cluster.map((s) => s.outside_temp_avg)), 2),
      geofence_id: geofenceId,
    },
  }
}

/** Plan merges across many users/vins: cluster per (user_id, vin); >=2 → merge. */
export function planMerges(sessions: MergeSession[], gapMs: number): MergePlan[] {
  const byKey = new Map<string, MergeSession[]>()
  for (const s of sessions) {
    const k = `${s.user_id}|${s.vin}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(s)
  }
  const plans: MergePlan[] = []
  for (const list of byKey.values()) {
    for (const c of clusterSessions(list, gapMs)) if (c.length > 1) plans.push(mergeCluster(c))
  }
  return plans
}

// ── DB driver ─────────────────────────────────────────────────────────────

/** Merge fragments for every user. Called from the hourly reconcile cron. */
export async function mergeChargeFragmentsAllUsers(gapMs = DEFAULT_GAP_MS): Promise<MergeSummary> {
  return withDb((db) => mergeChargeFragments(db, gapMs))
}

/**
 * Merge fragmented closed, non-Supercharger charge sessions. Pass `userId` to
 * scope to one user (UI trigger); omit to sweep all users (cron).
 */
export async function mergeChargeFragments(
  db: Db,
  gapMs = DEFAULT_GAP_MS,
  userId?: string,
): Promise<MergeSummary> {
  const summary: MergeSummary = { scanned: 0, merged: 0, deleted: 0, repointed: 0, errors: [] }

  const rows = (await db
    .select({
      id: chargeSession.id,
      user_id: chargeSession.user_id,
      vin: chargeSession.vin,
      source: chargeSession.source,
      started_at: chargeSession.started_at,
      ended_at: chargeSession.ended_at,
      energy_added_kwh: chargeSession.energy_added_kwh,
      energy_used_kwh: chargeSession.energy_used_kwh,
      cost_amount: chargeSession.cost_amount,
      cost_currency: chargeSession.cost_currency,
      cost_source: chargeSession.cost_source,
      rate_applied: chargeSession.rate_applied,
      miles_added_rated: chargeSession.miles_added_rated,
      start_range_mi: chargeSession.start_range_mi,
      end_range_mi: chargeSession.end_range_mi,
      start_battery_level: chargeSession.start_battery_level,
      end_battery_level: chargeSession.end_battery_level,
      outside_temp_avg: chargeSession.outside_temp_avg,
      geofence_id: chargeSession.geofence_id,
      invoices: chargeSession.invoices,
    })
    .from(chargeSession)
    .where(
      and(
        isNotNull(chargeSession.ended_at),
        ne(chargeSession.source, 'supercharger'),
        userId ? eq(chargeSession.user_id, userId) : undefined,
      ),
    )) as MergeSession[]

  summary.scanned = rows.length
  const plans = planMerges(rows, gapMs)

  for (const p of plans) {
    try {
      await db.transaction(async (tx) => {
        if (p.absorbedIds.length) {
          const rep = await tx
            .update(vehicleSnapshot)
            .set({ source_charge_id: p.survivorId })
            .where(
              and(
                eq(vehicleSnapshot.user_id, p.userId),
                inArray(vehicleSnapshot.source_charge_id, p.absorbedIds),
              ),
            )
          summary.repointed += (rep as unknown as { count?: number }).count ?? 0
        }
        await tx
          .update(chargeSession)
          .set({ ...p.set, updated_at: new Date().toISOString() })
          .where(and(eq(chargeSession.id, p.survivorId), eq(chargeSession.user_id, p.userId)))
        const del = await tx
          .delete(chargeSession)
          .where(and(eq(chargeSession.user_id, p.userId), inArray(chargeSession.id, p.absorbedIds)))
        summary.deleted += (del as unknown as { count?: number }).count ?? 0
      })
      summary.merged++
    } catch (e) {
      summary.errors.push(`survivor ${p.survivorId}: ${(e as Error).message}`)
    }
  }
  return summary
}
