/**
 * Centralized pure display formatters shared across the dashboard routes
 * (charging / charging_.insights / drives_.insights / analytics / detail).
 *
 * These were previously duplicated verbatim as local `money` / `round1` /
 * `fmtDuration` helpers in five+ files. Unit helpers (mi/km, temp, etc.) live in
 * `./units` — this module re-exports the few that callers reach for alongside
 * money so there is one import surface for "formatting", without duplicating the
 * unit math itself.
 */

// Re-export the unit-conversion surface so callers can pull distance/energy/etc.
// formatters from one place. The canonical math stays in ./units (single source
// of truth — do NOT reimplement MI_PER_KM here).
export {
  MI_PER_KM,
  distUnit,
  effFromWhKm,
  effSuffix,
  effUnit,
  elevUnit,
  fmtDay,
  fmtDist,
  fmtElev,
  fmtPres,
  fmtSpeed,
  fmtTemp,
  presUnit,
  speedUnit,
  tempUnit,
} from './units'

/** Round to one decimal place (Math.round(n*10)/10). */
export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Round to two decimal places (Math.round(n*100)/100). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * "$1.84" for USD, "1.84 EUR" otherwise; "—" when there's nothing to show.
 *
 * `digits` controls the fixed decimal places (default 2). The dashboard's
 * charge/cost cards historically used 2; the insights pages used 0 — pass
 * `digits: 0` for whole-dollar contexts. `currency` defaults to USD.
 */
export function money(
  amount: number | null | undefined,
  currency: string | null = 'USD',
  digits = 2,
): string {
  if (amount == null) return '—'
  const c = currency || 'USD'
  const v = amount.toFixed(digits)
  return c === 'USD' ? `$${v}` : `${v} ${c}`
}

/**
 * Minutes → "11m" / "1h 4m" duration label (drives/charging history + detail).
 * Negative/NaN clamps to 0m.
 */
export function fmtDurMin(min: number): string {
  const m = Math.max(0, Math.round(min || 0))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

/**
 * Seconds → "5m" / "2h 13m" / "3d 4h" duration label (analytics time-in-state).
 * Rolls up to days past 24h.
 */
export function fmtDurSec(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0))
  const h = Math.floor(s / 3600)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ${h % 24}h`
  const m = Math.floor((s % 3600) / 60)
  return h >= 1 ? `${h}h ${m}m` : `${m}m`
}

/** "12.3 kWh" / "—" — energy label rounded to one decimal. */
export function kwh(n: number | null | undefined): string {
  return n == null ? '—' : `${round1(n)} kWh`
}
