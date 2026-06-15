/**
 * Pure unit/value conversions for the TeslaMate → tesboard importer.
 *
 * TeslaMate stores everything metric (km, km/h, °C, kWh, bar) regardless of the
 * user's display units; tesboard stores distances/ranges/speed in MILES and
 * temps in °C. These helpers do the math and NOTHING else, so they are trivially
 * unit-testable (see convert.test.ts). The orchestrator (import-teslamate.mjs)
 * is the only place that touches the database.
 *
 * Plain JS (with JSDoc types) on purpose: the CLI runs under bare `node` with no
 * build step, and the vitest suite imports this same module.
 */

/** Exact statute-mile / kilometre ratio. */
export const KM_TO_MI = 1 / 1.609344
export const MI_TO_KM = 1.609344

/** km → mi (null/undefined pass through as null). */
export function kmToMi(km) {
  if (km == null || !Number.isFinite(km)) return null
  return km * KM_TO_MI
}

/** km/h → mph (same ratio). */
export function kmhToMph(kmh) {
  return kmToMi(kmh)
}

/**
 * TeslaMate `cars.efficiency` is kWh per km. tesboard wants Wh per *mile*:
 *   Wh/mi = (kWh/km) × 1000 (Wh/kWh) × 1.609344 (km/mi)
 */
export function efficiencyKwhPerKmToWhPerMi(effKwhPerKm) {
  if (effKwhPerKm == null || !Number.isFinite(effKwhPerKm) || effKwhPerKm <= 0) return null
  return effKwhPerKm * 1000 * MI_TO_KM
}

/**
 * Derive a drive's energy (kWh) from its range drop, because TeslaMate has no
 * per-drive kWh column. energy = (startRangeKm − endRangeKm) × efficiency(kWh/km).
 * Negative deltas (net charge mid-window) or missing inputs → null.
 */
export function driveEnergyKwh(startRangeKm, endRangeKm, effKwhPerKm) {
  if (startRangeKm == null || endRangeKm == null) return null
  if (effKwhPerKm == null || !(effKwhPerKm > 0)) return null
  const deltaKm = startRangeKm - endRangeKm
  if (!(deltaKm > 0)) return null
  return deltaKm * effKwhPerKm
}

/**
 * Wh per mile from energy (kWh) and distance (mi). Guards divide-by-zero and
 * sub-mile quantization noise (matches poller MIN_WHPM_DISTANCE_MI = 1).
 */
export function whPerMi(energyKwh, distanceMi) {
  if (energyKwh == null || !(energyKwh > 0)) return null
  if (distanceMi == null || !(distanceMi >= 1)) return null
  return (energyKwh * 1000) / distanceMi
}

/** Minutes → seconds (rounded), null-safe. */
export function minutesToSeconds(min) {
  if (min == null || !Number.isFinite(min)) return null
  return Math.round(min * 60)
}

const DC_CHARGER_TYPES = new Set(['Supercharger', 'CCS', 'CHAdeMO', 'Combo', 'DC'])

/** Is this a DC fast-charge (Supercharger-class) session? */
export function isDcFastCharge(fastChargerType, fastChargerBrand) {
  const t = (fastChargerType ?? '').toString()
  const b = (fastChargerBrand ?? '').toString()
  if (DC_CHARGER_TYPES.has(t)) return true
  if (/supercharger|tesla/i.test(b) && t && t !== '<invalid>' && t !== 'ACSingleWireCAN') return false
  return /super|ccs|chademo|dc/i.test(t)
}

/**
 * Decide cost_amount/cost_source/source for an imported charge.
 *   - DC + free supercharging → 0, 'tesla_billed_free', source 'supercharger'
 *   - DC                      → TeslaMate cost, 'tesla_billed',      'supercharger'
 *   - AC                      → TeslaMate cost, 'imported_teslamate', 'home'
 * A null TeslaMate cost stays null (cost unknown), not 0.
 */
export function mapChargeCost({ fastChargerType, fastChargerBrand, freeSupercharging, tmCost }) {
  const dc = isDcFastCharge(fastChargerType, fastChargerBrand)
  if (dc && freeSupercharging) {
    return { source: 'supercharger', cost_source: 'tesla_billed_free', cost_amount: 0 }
  }
  if (dc) {
    return {
      source: 'supercharger',
      cost_source: 'tesla_billed',
      cost_amount: tmCost == null ? null : Number(tmCost),
    }
  }
  return {
    source: 'home',
    cost_source: 'imported_teslamate',
    cost_amount: tmCost == null ? null : Number(tmCost),
  }
}

/** Normalize a charge_location_type from the DC flag + whether a geofence matched. */
export function chargeLocationType({ isDc, hasGeofence, geofenceIsHome }) {
  if (isDc) return 'supercharger'
  if (hasGeofence) return geofenceIsHome ? 'home' : 'away'
  return 'unknown'
}

/** TeslaMate geofence billing_type → tesboard ('per_kwh' | 'per_minute' | 'per_session'). */
export function mapBillingType(tm) {
  const v = (tm ?? '').toString().toLowerCase()
  if (v === 'per_minute' || v === '1' || v === 'minute') return 'per_minute'
  if (v === 'per_session' || v === 'session') return 'per_session'
  return 'per_kwh'
}

/**
 * Time-based downsampler for the huge sample streams (positions / charges).
 * Keeps the first and last row of `rows` plus any row at least `minIntervalSec`
 * after the last kept one. `tsOf(row)` must return an ISO string or epoch ms.
 * `keepIf(row)` (optional) force-keeps a row (e.g. a state/shift change).
 */
export function downsampleByInterval(rows, minIntervalSec, tsOf, keepIf) {
  if (minIntervalSec <= 0 || rows.length <= 2) return rows.slice()
  const ms = minIntervalSec * 1000
  const out = []
  let lastKept = -Infinity
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const t = typeof tsOf(row) === 'number' ? tsOf(row) : new Date(tsOf(row)).getTime()
    const forced = i === 0 || i === rows.length - 1 || (keepIf ? keepIf(row) : false)
    if (forced || t - lastKept >= ms) {
      out.push(row)
      lastKept = t
    }
  }
  return out
}
