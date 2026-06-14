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
