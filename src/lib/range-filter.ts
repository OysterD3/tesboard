/**
 * Date-range filter shared by the Insights pages (Drives / Charging / Idles).
 *
 * Pure module (no React, no Date.now() at import) — safe in the browser and unit
 * tests. The caller supplies "now" (anchored on a server-provided timestamp from
 * the dashboard loader) so a relative window resolves to the SAME bounds on the
 * SSR render and the first client render, avoiding a hydration mismatch.
 *
 * Custom ranges are capped at MAX_CUSTOM_DAYS so the heaviest *bounded* server
 * scan (phantom drain over raw snapshots) stays well inside the proven-safe
 * envelope; only "All time" is unbounded, and that path aggregates in SQL.
 */

export type RangeKey = '7d' | '30d' | 'all' | 'custom'

/** Custom ranges may not span more than this many days. */
export const MAX_CUSTOM_DAYS = 60

const DAY_MS = 86_400_000

export interface RangeState {
  key: RangeKey
  /** 'YYYY-MM-DD' (local date-picker value); only meaningful when key === 'custom'. */
  customFrom?: string | null
  customTo?: string | null
}

/** Resolved bounds in epoch-ms. `null` on a side means "unbounded" (open). */
export interface ResolvedRange {
  fromMs: number | null
  toMs: number | null
}

export const ALL_TIME: ResolvedRange = { fromMs: null, toMs: null }

const startOfDayUtcMs = (ymd: string): number | null => {
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  return Number.isNaN(ms) ? null : ms
}
const endOfDayUtcMs = (ymd: string): number | null => {
  const ms = Date.parse(`${ymd}T23:59:59.999Z`)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Resolve a range selection to concrete epoch-ms bounds. Relative windows
 * ("7d"/"30d") are measured back from `nowMs`; "all" is open on both ends; a
 * valid "custom" pair is clamped to MAX_CUSTOM_DAYS (start pulled forward).
 * An incomplete/invalid custom selection falls back to all-time so the page
 * still shows data rather than going blank.
 */
export function resolveRange(state: RangeState, nowMs: number): ResolvedRange {
  switch (state.key) {
    case '7d':
      return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs }
    case '30d':
      return { fromMs: nowMs - 30 * DAY_MS, toMs: nowMs }
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

/**
 * Normalise a custom date pair: order it (swap if reversed) and cap the span at
 * MAX_CUSTOM_DAYS by pulling the start date forward toward the end. Returns
 * 'YYYY-MM-DD' strings; inputs that don't parse are returned unchanged.
 */
export function clampCustom(from: string, to: string): { from: string; to: string } {
  let a = startOfDayUtcMs(from)
  let b = startOfDayUtcMs(to)
  if (a == null || b == null) return { from, to }
  if (a > b) [a, b] = [b, a]
  if (b - a > MAX_CUSTOM_DAYS * DAY_MS) a = b - MAX_CUSTOM_DAYS * DAY_MS
  return { from: toYmdUtc(a), to: toYmdUtc(b) }
}

/** Inclusive membership test against resolved bounds (open side = no bound). */
export function inResolvedRange(iso: string, r: ResolvedRange): boolean {
  if (r.fromMs == null && r.toMs == null) return true
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  if (r.fromMs != null && t < r.fromMs) return false
  if (r.toMs != null && t > r.toMs) return false
  return true
}

/** Filter rows carrying an ISO `started_at`. Returns the input untouched for all-time. */
export function filterByRange<T extends { started_at: string }>(rows: T[], r: ResolvedRange): T[] {
  if (r.fromMs == null && r.toMs == null) return rows
  return rows.filter((row) => inResolvedRange(row.started_at, r))
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

/** Human label for the current selection (used in the cards' subtitles). */
export function rangeLabel(state: RangeState): string {
  switch (state.key) {
    case '7d':
      return 'Last 7 days'
    case '30d':
      return 'Last 30 days'
    case 'all':
      return 'All time'
    case 'custom':
      if (!state.customFrom || !state.customTo) return 'Custom'
      return `${fmtYmd(state.customFrom)} – ${fmtYmd(state.customTo)}`
    default:
      return 'All time'
  }
}

/** ISO bounds for a server call. `{from:null,to:null}` ⇒ all-time (server aggregates). */
export function rangeToIso(r: ResolvedRange): { from: string | null; to: string | null } {
  return {
    from: r.fromMs == null ? null : new Date(r.fromMs).toISOString(),
    to: r.toMs == null ? null : new Date(r.toMs).toISOString(),
  }
}

/**
 * Server-side guard for a BOUNDED Insights window. The client clamps custom
 * ranges to MAX_CUSTOM_DAYS, but server fns are independently-reachable RPCs, so
 * the bound MUST be re-enforced here — otherwise a crafted request (e.g.
 * from='2000-01-01', to='2100-01-01') would drive an unbounded raw-snapshot scan
 * and blow the Worker CPU budget. Caps the span at MAX_CUSTOM_DAYS by pulling
 * `from` forward toward `to`. Returns ISO bounds, or `null` when `from` can't be
 * parsed (callers treat that as all-time, which aggregates in SQL).
 */
export function clampServerWindow(fromIso: string, toIso: string | null): { from: string; to: string } | null {
  const fromMs = Date.parse(fromIso)
  if (Number.isNaN(fromMs)) return null
  let toMs = toIso ? Date.parse(toIso) : NaN
  if (Number.isNaN(toMs) || toMs < fromMs) toMs = fromMs + MAX_CUSTOM_DAYS * DAY_MS
  const from = toMs - fromMs > MAX_CUSTOM_DAYS * DAY_MS ? toMs - MAX_CUSTOM_DAYS * DAY_MS : fromMs
  return { from: new Date(from).toISOString(), to: new Date(toMs).toISOString() }
}
