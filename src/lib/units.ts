/**
 * Unit conversion + display formatting for the dashboard. All helpers take a
 * single `Units` selection and a canonical value:
 *   distance → kilometres   temperature → °C   pressure → bar
 *   efficiency → Wh/km      speed → km/h        energy → kWh
 * Live DB values (stored in miles / Wh-per-mile) are converted to canonical at
 * the view-model boundary (see lib/dashboard-vm.ts), so these stay pure.
 */
export type DistUnit = 'mi' | 'km'
export type TempUnit = 'f' | 'c'
export type PresUnit = 'psi' | 'bar'
export type EffUnit = 'mi' | 'whkm'

export interface Units {
  dist: DistUnit
  temp: TempUnit
  pres: PresUnit
  eff: EffUnit
}

export const DEFAULT_UNITS: Units = { dist: 'mi', temp: 'f', pres: 'psi', eff: 'mi' }

export const MI_PER_KM = 1 / 1.60934

function r(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export function fmtDist(u: Units, km: number, d = 0): number {
  return u.dist === 'mi' ? r(km * MI_PER_KM, d) : r(km, d)
}
export function distUnit(u: Units): string {
  return u.dist === 'mi' ? 'mi' : 'km'
}
export function fmtSpeed(u: Units, kph: number): number {
  return u.dist === 'mi' ? r(kph * MI_PER_KM) : r(kph)
}
export function speedUnit(u: Units): string {
  return u.dist === 'mi' ? 'mph' : 'km/h'
}
export function fmtTemp(u: Units, c: number): number {
  return u.temp === 'f' ? r((c * 9) / 5 + 32) : r(c)
}
export function tempUnit(u: Units): string {
  return u.temp === 'f' ? '°F' : '°C'
}
export function fmtPres(u: Units, bar: number): number {
  return u.pres === 'psi' ? r(bar * 14.5038) : r(bar, 1)
}
export function presUnit(u: Units): string {
  return u.pres === 'psi' ? 'psi' : 'bar'
}
/** Elevation: canonical metres → feet (imperial distance) or metres (metric). */
export function fmtElev(u: Units, m: number): number {
  return u.dist === 'mi' ? r(m * 3.28084) : r(m)
}
export function elevUnit(u: Units): string {
  return u.dist === 'mi' ? 'ft' : 'm'
}
/** Wh/km → the selected efficiency unit (mi/kWh or Wh/km). */
export function effFromWhKm(u: Units, whkm: number): number {
  if (u.eff === 'mi') return r(1000 / whkm / 1.60934, 1)
  return r(whkm)
}
export function effUnit(u: Units): string {
  return u.eff === 'mi' ? 'mi / kWh' : 'Wh / km'
}
/** Short suffix form for inline use (e.g. drive cards). */
export function effSuffix(u: Units): string {
  return u.eff === 'mi' ? 'mi/kWh' : 'Wh/km'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A `YYYY-MM-DD` day string → a short "Jun 18" label. The month name is read
 * from a fixed table (not `toLocaleDateString`) so server and client always
 * agree byte-for-byte — no timezone shift and no dependency on the runtime's
 * locale data, both of which are sources of the React #418 hydration class.
 * Out-of-range / unparseable input falls back to the raw string.
 */
export function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return ymd
  return `${MONTHS[m - 1]} ${d}`
}
