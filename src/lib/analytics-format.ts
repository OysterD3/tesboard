/**
 * Analytics-page-local display helpers. Generic formatters (round1, fmtDurSec)
 * live in `./format`; STATE_COLORS lives in the dashboard theme. This module only
 * holds the speed-bin label, which depends on the unit-conversion surface.
 */
import { fmtSpeed, type Units } from './units'

const MI_TO_KM = 1.609344

/** Label a speed bucket (lower edge, mph) as a display-unit range, e.g. "30–40". */
export function speedBinLabel(u: Units, lowerMph: number, binMph = 10): string {
  return `${fmtSpeed(u, lowerMph * MI_TO_KM)}–${fmtSpeed(u, (lowerMph + binMph) * MI_TO_KM)}`
}
