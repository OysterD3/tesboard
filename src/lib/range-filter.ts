/**
 * Date-range filter shared by every dated dashboard view (Drives / Charging /
 * Idles → History, Map and Insights).
 *
 * Pure module (no React, no Date.now() at import) — safe in the browser, the
 * Worker, and unit tests. Callers supply "now" (anchored on a server-provided
 * timestamp from the dashboard loader) so a relative window resolves to the SAME
 * bounds on the SSR render and the first client render, avoiding a hydration
 * mismatch. Calendar windows (Today / Yesterday / This year / Last year) are cut
 * on UTC boundaries — matching the rest of the app's UTC day-bucketing — so they
 * too are stable across SSR/client.
 *
 * There is no client-side span cap: client views filter already-loaded rows, and
 * the only server scans (Idles phantom drain/causes) route a large window to a
 * per-day SQL aggregation instead, so any range is CPU-safe.
 */

export type RangeKey =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'thisYear'
  | 'lastYear'
  | 'sinceLastCharge'
  | 'all'
  | 'custom'

const DAY_MS = 86_400_000

export interface RangeState {
  key: RangeKey
  /** 'YYYY-MM-DD' (date-picker value); only meaningful when key === 'custom'. */
  customFrom?: string | null
  customTo?: string | null
}

/** Resolved bounds in epoch-ms. `null` on a side means "unbounded" (open). */
export interface ResolvedRange {
  fromMs: number | null
  toMs: number | null
}

export const ALL_TIME: ResolvedRange = { fromMs: null, toMs: null }

/** Ordered chip metadata for the filter UI. `sinceLastCharge` is hidden when the
 *  account has no charges yet; `custom` reveals the date inputs. */
export const RANGE_CHIPS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'thisYear', label: 'This year' },
  { key: 'lastYear', label: 'Last year' },
  { key: 'sinceLastCharge', label: 'Since last charge' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom' },
]

const startOfDayUtcMs = (ymd: string): number | null => {
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  return Number.isNaN(ms) ? null : ms
}
const endOfDayUtcMs = (ymd: string): number | null => {
  const ms = Date.parse(`${ymd}T23:59:59.999Z`)
  return Number.isNaN(ms) ? null : ms
}
const startOfUtcDay = (ms: number): number => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const startOfUtcYear = (ms: number): number => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), 0, 1)
}

/**
 * Resolve a range selection to concrete epoch-ms bounds. Relative windows
 * ("7d"/"30d") count back from `nowMs`; calendar windows cut on UTC boundaries;
 * "sinceLastCharge" runs from the most recent charge to now (all-time if there's
 * no charge); "all" is open; an incomplete custom selection falls back to
 * all-time so the page still shows data rather than going blank.
 */
export function resolveRange(state: RangeState, nowMs: number, lastChargeMs: number | null = null): ResolvedRange {
  switch (state.key) {
    case 'today':
      return { fromMs: startOfUtcDay(nowMs), toMs: nowMs }
    case 'yesterday': {
      const start = startOfUtcDay(nowMs)
      return { fromMs: start - DAY_MS, toMs: start - 1 }
    }
    case '7d':
      return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs }
    case '30d':
      return { fromMs: nowMs - 30 * DAY_MS, toMs: nowMs }
    case 'thisYear':
      return { fromMs: startOfUtcYear(nowMs), toMs: nowMs }
    case 'lastYear': {
      const start = startOfUtcYear(nowMs)
      return { fromMs: startOfUtcYear(start - 1), toMs: start - 1 }
    }
    case 'sinceLastCharge':
      return lastChargeMs == null ? ALL_TIME : { fromMs: lastChargeMs, toMs: nowMs }
    case 'all':
      return ALL_TIME
    case 'custom': {
      if (!state.customFrom || !state.customTo) return ALL_TIME
      const clamped = clampCustom(state.customFrom, state.customTo)
      const fromMs = startOfDayUtcMs(clamped.from)
      const toMs = endOfDayUtcMs(clamped.to)
      if (fromMs == null || toMs == null) return ALL_TIME
      return { fromMs, toMs }
    }
    default:
      return ALL_TIME
  }
}

/** Order a custom date pair (swap if reversed). Inputs that don't parse pass through. */
export function clampCustom(from: string, to: string): { from: string; to: string } {
  const a = startOfDayUtcMs(from)
  const b = startOfDayUtcMs(to)
  if (a == null || b == null) return { from, to }
  return a > b ? { from: to, to: from } : { from, to }
}

/** Inclusive membership test for an epoch-ms instant (open side = no bound). */
export function inRangeMs(ms: number, r: ResolvedRange): boolean {
  if (r.fromMs == null && r.toMs == null) return true
  if (Number.isNaN(ms)) return false
  if (r.fromMs != null && ms < r.fromMs) return false
  if (r.toMs != null && ms > r.toMs) return false
  return true
}

/** Inclusive membership test against resolved bounds for an ISO timestamp. */
export function inResolvedRange(iso: string, r: ResolvedRange): boolean {
  if (r.fromMs == null && r.toMs == null) return true
  return inRangeMs(Date.parse(iso), r)
}

/** Filter rows carrying an ISO `started_at`. Returns the input untouched for all-time. */
export function filterByRange<T extends { started_at: string }>(rows: T[], r: ResolvedRange): T[] {
  if (r.fromMs == null && r.toMs == null) return rows
  return rows.filter((row) => inResolvedRange(row.started_at, r))
}

/** Most recent charge instant (ended_at, else started_at) in epoch-ms, or null. */
export function lastChargeMsOf(sessions: Array<{ started_at: string; ended_at: string | null }>): number | null {
  let max: number | null = null
  for (const s of sessions) {
    const t = Date.parse(s.ended_at ?? s.started_at)
    if (!Number.isNaN(t) && (max == null || t > max)) max = t
  }
  return max
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** epoch-ms → 'YYYY-MM-DD' (UTC), no Intl/Date locale (hydration-safe). */
export function toYmdUtc(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 'YYYY-MM-DD' → 'Mon D' using a fixed month table (no Intl; hydration-safe). */
function fmtYmd(ymd: string): string {
  const ms = startOfDayUtcMs(ymd)
  if (ms == null) return ymd
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** Human label for the current selection (chips + card subtitles). */
export function rangeLabel(state: RangeState): string {
  if (state.key === 'custom') {
    if (!state.customFrom || !state.customTo) return 'Custom'
    return `${fmtYmd(state.customFrom)} – ${fmtYmd(state.customTo)}`
  }
  return RANGE_CHIPS.find((c) => c.key === state.key)?.label ?? 'All time'
}

/** ISO bounds for a server call. `{from:null,to:null}` ⇒ all-time (server aggregates). */
export function rangeToIso(r: ResolvedRange): { from: string | null; to: string | null } {
  return {
    from: r.fromMs == null ? null : new Date(r.fromMs).toISOString(),
    to: r.toMs == null ? null : new Date(r.toMs).toISOString(),
  }
}
