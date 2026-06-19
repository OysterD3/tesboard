/**
 * Pure charge-session merge logic for scripts/merge-charges.mjs. No DB/IO —
 * unit-tested in ./merge.test.ts.
 *
 * Stop/start charging (e.g. unplug/replug to reset a balky AC charger) makes the
 * poller / Tessie+TeslaMate importers record ONE physical plug-in as several
 * charge_session rows. This module clusters those fragments back into one plug-in
 * and computes the merged row.
 *
 * Two sessions join the same cluster when they share a source and EITHER:
 *   - they carry the same QuickCharge receipt number (authoritative plug-in
 *     boundary — joins regardless of the gap between segments), OR
 *   - the gap between the running cluster's latest `ended_at` and the next
 *     `started_at` is <= gapMs (a brief reset), AND they don't carry two DIFFERENT
 *     receipt numbers (two distinct billed plug-ins never merge).
 *
 * The earliest session in a cluster is the SURVIVOR (its id is kept); the others
 * are absorbed (their ids are deleted by the orchestrator, their snapshots
 * repointed to the survivor). Merging is idempotent: a survivor re-clustered later
 * is alone (gap to neighbours is large) so it is a no-op.
 */

/** QuickCharge receipt number on a session, or null. */
export function receiptOf(s) {
  const inv = s.invoices
  if (inv && typeof inv === 'object' && inv.quickcharge && inv.quickcharge.receiptNo != null) {
    return String(inv.quickcharge.receiptNo)
  }
  return null
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN)
const sum = (arr) => {
  const vals = arr.filter((v) => v != null && Number.isFinite(v))
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null
}
const mean = (arr) => {
  const vals = arr.filter((v) => v != null && Number.isFinite(v))
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}
const round = (n, dp) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp)

// Authoritative-ness ranking for picking a merged cost_source.
const COST_RANK = ['computed', 'geofence', 'imported_teslamate', 'manual', 'tesla_billed_free', 'tesla_billed', 'quickcharge']

/**
 * Cluster sorted-by-started_at sessions into physical plug-ins.
 * @param sessions array of { id, source, started_at, ended_at, invoices, ... }
 * @param gapMs    max gap (ms) between segments to treat as one plug-in (no receipt)
 * @returns array of clusters (each an array of sessions, in started_at order)
 */
export function clusterSessions(sessions, gapMs) {
  const sorted = [...sessions].sort((a, b) => ms(a.started_at) - ms(b.started_at))
  const clusters = []
  let cur = null
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
    const joinable = s.source === prev.source && !diffReceipt && (sameReceipt || contiguous)
    if (joinable) {
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

/**
 * Compute the merged survivor row for a multi-session cluster (>=2). Returns
 * { survivorId, absorbedIds, set } where `set` is the column patch for the survivor.
 */
export function mergeCluster(cluster) {
  const byStart = [...cluster].sort((a, b) => ms(a.started_at) - ms(b.started_at))
  const survivor = byStart[0]
  const last = [...cluster].sort((a, b) => ms(a.ended_at) - ms(b.ended_at))[cluster.length - 1]

  const energyAdded = sum(cluster.map((s) => s.energy_added_kwh))
  const energyUsed = sum(cluster.map((s) => s.energy_used_kwh))
  const cost = sum(cluster.map((s) => s.cost_amount))

  // miles added across the plug-in: prefer the range span, else sum of per-segment.
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
    absorbedIds: byStart.slice(1).map((s) => s.id),
    set: {
      ended_at: last.ended_at,
      energy_added_kwh: energyAdded,
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

/** Full plan: clusters with >=2 sessions become merges. */
export function planMerges(sessions, gapMs) {
  return clusterSessions(sessions, gapMs)
    .filter((c) => c.length > 1)
    .map(mergeCluster)
}
