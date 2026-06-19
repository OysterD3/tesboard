/**
 * Pure reconciliation engine for the QuickCharge receipt importer
 * (scripts/import-quickcharge.mjs). No DB / IO — unit-tested in ./reconcile.test.ts.
 *
 * The problem: QuickCharge bills per *plug-in* and gives one authoritative receipt
 * (RM cost + grid-side meter kWh) per session. The car's poller / Tessie+TeslaMate
 * importers, however, split a single physical plug-in into several `charge_session`
 * rows (the car briefly stops/resumes during taper or cell balancing). So one
 * receipt usually maps to N local sessions on the same calendar day.
 *
 * Strategy (matches the user-approved design):
 *   1. Group the car's non-Supercharger sessions by LOCAL calendar date
 *      (started_at is UTC; local = UTC + offsetMin, Malaysia = +480).
 *   2. For each receipt, take the same-date group, dropping implausible members:
 *        - duration > MAX_PLUG_HOURS  → corrupt/unclosed session (e.g. a 42-day row)
 *        - energy_added_kwh > usage × MAX_ADDED_RATIO → can't belong to this receipt
 *      Excluded rows are reported, never silently dropped.
 *   3. Distribute the receipt's RM cost and grid kWh across the surviving sessions
 *      PROPORTIONALLY to each session's energy_added_kwh (battery side). Rounding
 *      remainder lands on the last share so the totals stay exact.
 *   4. Loss-ratio sanity (grid ÷ battery should be ~1.0–1.3). If a group's ratio is
 *      outside [MIN_RATIO, MAX_RATIO] the match is flagged for REVIEW and NOT applied
 *      automatically (energy was swallowed elsewhere — don't write distorted data).
 *   5. Receipts with no same-date session → standalone GAP insert so the spend +
 *      grid energy still show up (mirrors reconcile.ts for unmatched Supercharger
 *      records). Time-of-day is unknown, so the row is stamped at local noon and the
 *      duration is estimated from energy at ASSUMED_KW.
 *
 * All emitted costs use cost_source 'quickcharge' (authoritative; frozen by
 * reclassify/repair in rate.functions.ts).
 *
 * Known limitations (human-in-the-loop tool — surfaced, not silently wrong):
 *   - Receipt 'date' is assumed to be the LOCAL date the charge STARTED. A plug-in
 *     that straddles local midnight has its split rows in two date buckets; only
 *     the start-date bucket is grouped, so the tail lands in `unmatchedSessions`
 *     and/or the loss ratio drops below MIN_LOSS_RATIO → the receipt is sent to
 *     `review` rather than mis-applied. Resolve those by hand.
 *   - A matched group may mix sessions with and without battery-added energy; the
 *     null/zero ones are deliberately zero-weighted (they are taper "blips" that
 *     added no energy) so the full receipt lands on the real charging sessions.
 */

export const QUICKCHARGE_SOURCE = 'quickcharge'

// A real AC plug-in never runs longer than this; anything above is a corrupt /
// never-closed session that must not absorb a receipt.
export const MAX_PLUG_HOURS = 24
// A single session whose battery-added energy already exceeds the receipt's grid
// energy by this factor cannot be part of that receipt (grid ≥ battery, always).
export const MAX_ADDED_RATIO = 1.4
// Plausible grid-kWh ÷ battery-kWh window (AC charge + metering losses). Outside
// this, the match is suspect and is sent to review instead of being applied.
export const MIN_LOSS_RATIO = 0.85
export const MAX_LOSS_RATIO = 1.4
// Assumed AC charge power (kW) used only to estimate a gap row's duration.
export const ASSUMED_KW = 7

const MS_PER_HOUR = 3_600_000

/** Round to `dp` decimals (banker-free, half-up). */
export function round(n, dp) {
  if (n == null || !Number.isFinite(n)) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/** UTC ISO → 'YYYY-MM-DD' in local time (UTC + offsetMin). */
export function localDateOf(iso, offsetMin) {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10)
}

/** Local 'YYYY-MM-DD' at a given local hour → UTC ISO instant. */
export function localClockToUtcIso(dateStr, localHour, offsetMin) {
  const baseMs = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(baseMs)) return null
  const ms = baseMs + localHour * MS_PER_HOUR - offsetMin * 60_000
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Duration (s) of a session, or null if either bound is missing/invalid. */
export function durationS(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null
  const a = Date.parse(startedAt)
  const b = Date.parse(endedAt)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, Math.round((b - a) / 1000))
}

/**
 * Split `total` across `weights` proportionally, rounded to `dp`, with the
 * rounding remainder absorbed by the LAST weighted entry so Σ === total exactly.
 * Zero-weight entries get 0. Returns an array aligned to `weights`.
 */
export function distribute(total, weights, dp) {
  const sum = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0)
  const out = weights.map(() => 0)
  if (sum <= 0) return out
  let allocated = 0
  let lastIdx = -1
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) lastIdx = i
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] <= 0) continue
    if (i === lastIdx) {
      out[i] = round(total - allocated, dp)
    } else {
      const share = round((total * weights[i]) / sum, dp)
      out[i] = share
      allocated += share
    }
  }
  return out
}

/**
 * Reconcile receipts against the car's sessions.
 *
 * @param {object}   p
 * @param {Array}    p.receipts  [{ receiptNo, date 'YYYY-MM-DD', charger, spent, usageKwh }]
 * @param {Array}    p.sessions  NON-supercharger charge_session rows:
 *                               [{ id, started_at, ended_at, energy_added_kwh, cost_source }]
 * @param {number}   p.offsetMin local-time offset east of UTC (Malaysia = 480)
 * @param {object}   p.geofence  { id, is_home } for the QuickCharge location (or null)
 * @param {number}   [p.assumedKw=ASSUMED_KW]
 * @returns {{ applies:Array, inserts:Array, review:Array, excluded:Array, unmatchedSessions:Array }}
 */
export function reconcile({ receipts, sessions, offsetMin, geofence, assumedKw = ASSUMED_KW }) {
  const gfId = geofence?.id ?? null
  const locType = geofence?.is_home ? 'home' : 'away'

  // Index sessions by local date.
  const byDate = new Map()
  for (const s of sessions) {
    const d = localDateOf(s.started_at, offsetMin)
    if (!d) continue
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d).push(s)
  }

  const applies = []
  const inserts = []
  const review = []
  const excluded = []
  const claimed = new Set() // session ids assigned to some receipt

  // Receipts are matched by local calendar date. If two receipts fall on the SAME
  // local date we cannot reliably attribute that day's sessions between them (the
  // receipt 'charger' has no counterpart on charge_session, and a single day can
  // hold two independent plug-ins). Auto-applying would let the second receipt's
  // UPDATEs overwrite the first's and silently lose money — so route every receipt
  // on a contested date to review for manual resolution instead.
  const receiptsPerDate = new Map()
  for (const r of receipts) receiptsPerDate.set(r.date, (receiptsPerDate.get(r.date) ?? 0) + 1)

  for (const r of receipts) {
    const usage = r.usageKwh

    if ((receiptsPerDate.get(r.date) ?? 0) > 1) {
      review.push({
        receiptNo: r.receiptNo,
        date: r.date,
        reason: 'multiple receipts share this local date — cannot auto-attribute sessions; resolve manually',
        receiptUsageKwh: usage,
        receiptSpent: r.spent,
        groupAddedKwh: null,
        sessionIds: (byDate.get(r.date) ?? []).map((s) => s.id),
      })
      continue
    }

    const group = (byDate.get(r.date) ?? []).slice().sort((a, b) => a.started_at.localeCompare(b.started_at))

    // Partition the same-date group into usable members vs excluded outliers.
    const members = []
    for (const s of group) {
      if (claimed.has(s.id)) continue // never let two receipts claim the same session
      const dur = durationS(s.started_at, s.ended_at)
      if (dur != null && dur > MAX_PLUG_HOURS * 3600) {
        excluded.push({ id: s.id, receiptNo: r.receiptNo, reason: `duration ${(dur / 3600).toFixed(1)}h > ${MAX_PLUG_HOURS}h (corrupt/unclosed)`, started_at: s.started_at, ended_at: s.ended_at })
        continue
      }
      if (s.energy_added_kwh != null && usage > 0 && s.energy_added_kwh > usage * MAX_ADDED_RATIO) {
        excluded.push({ id: s.id, receiptNo: r.receiptNo, reason: `added ${s.energy_added_kwh}kWh > receipt ${usage}kWh × ${MAX_ADDED_RATIO}`, started_at: s.started_at, ended_at: s.ended_at })
        continue
      }
      members.push(s)
    }

    if (members.length === 0) {
      // No usable session → standalone gap insert.
      const started_at = localClockToUtcIso(r.date, 12, offsetMin)
      const estDurH = usage > 0 && assumedKw > 0 ? usage / assumedKw : 0
      const ended_at = new Date(Date.parse(started_at) + estDurH * MS_PER_HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z')
      inserts.push({
        receiptNo: r.receiptNo,
        charger: r.charger,
        started_at,
        ended_at,
        energy_added_kwh: null, // battery side unknown for a gap
        energy_used_kwh: round(usage, 4),
        cost_amount: round(r.spent, 4),
        rate_applied: usage > 0 ? round(r.spent / usage, 6) : null,
        geofence_id: gfId,
        charge_location_type: locType,
        duration_estimated: true,
      })
      continue
    }

    for (const s of members) claimed.add(s.id)

    const totalAdded = members.reduce((a, s) => a + (s.energy_added_kwh > 0 ? s.energy_added_kwh : 0), 0)
    const ratio = totalAdded > 0 ? usage / totalAdded : null

    // Loss-ratio sanity — only meaningful when we have a battery-side total.
    const suspect = ratio != null && (ratio < MIN_LOSS_RATIO || ratio > MAX_LOSS_RATIO)
    if (suspect || totalAdded <= 0) {
      review.push({
        receiptNo: r.receiptNo,
        date: r.date,
        reason:
          totalAdded <= 0
            ? 'matched session(s) have no battery-added energy to distribute against'
            : `grid/battery ratio ${ratio.toFixed(2)} outside [${MIN_LOSS_RATIO}, ${MAX_LOSS_RATIO}] — energy likely swallowed by another session`,
        receiptUsageKwh: usage,
        receiptSpent: r.spent,
        groupAddedKwh: round(totalAdded, 2),
        sessionIds: members.map((s) => s.id),
      })
      continue
    }

    // Proportional distribution across the surviving members. Members with no
    // battery-added energy (null / ≤0 — taper blips) get weight 0, so the receipt
    // lands entirely on the sessions that actually charged.
    const weights = members.map((s) => (s.energy_added_kwh > 0 ? s.energy_added_kwh : 0))
    const costs = distribute(r.spent, weights, 4)
    const energies = distribute(usage, weights, 4)
    const effRate = usage > 0 ? round(r.spent / usage, 6) : null
    members.forEach((s, i) => {
      applies.push({
        id: s.id,
        receiptNo: r.receiptNo,
        cost_amount: costs[i],
        energy_used_kwh: energies[i],
        rate_applied: effRate,
        geofence_id: gfId,
      })
    })
  }

  // Non-supercharger sessions not claimed by any receipt (informational).
  const unmatchedSessions = sessions
    .filter((s) => !claimed.has(s.id))
    .map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      energy_added_kwh: s.energy_added_kwh,
      cost_source: s.cost_source,
      localDate: localDateOf(s.started_at, offsetMin),
    }))

  return { applies, inserts, review, excluded, unmatchedSessions }
}
