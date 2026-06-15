/**
 * Charge-cost computation. Pure (no DB) so it's unit-testable; the poller and the
 * reclassify pass call it with the matched geofence + the user's home flat rate.
 *
 * Precedence (mirrors TeslaMate's cost model, adapted to tesboard):
 *   1. Supercharger + free supercharging  → 0, 'tesla_billed_free'
 *   2. Supercharger (paid)                → leave null; reconcile.ts fills the
 *      authoritative Tesla-billed amount. (cost_source stays 'computed' until then.)
 *   3. A matched geofence with a billing rule → 'geofence' cost:
 *        per_kwh:     MAX(used, added) × cost_per_unit + session_fee
 *        per_minute:  minutes × cost_per_unit + session_fee
 *        per_session: session_fee
 *   4. Home flat rate (no geofence rule, location is home) → energy × rate × loss
 *   5. Otherwise null (unknown — never guess).
 */
import type { BillingType, CostSource } from '../types/db'

export interface GeofenceRule {
  billing_type: BillingType
  cost_per_unit: number | null
  session_fee: number | null
  currency: string | null
  is_home: boolean
}

export interface HomeRate {
  flat_rate: number | null
  loss_factor: number | null
  currency: string | null
}

export interface ChargeCostInput {
  source: string // 'supercharger' | 'home' | ...
  freeSupercharging?: boolean
  energyAddedKwh: number | null
  energyUsedKwh?: number | null
  durationS?: number | null
  geofence?: GeofenceRule | null
  homeRate?: HomeRate | null
  /** True when the session's location was classified as home (flat-rate fallback). */
  isHome?: boolean
}

export interface ChargeCostResult {
  cost_amount: number | null
  cost_currency: string | null
  cost_source: CostSource
  rate_applied: number | null
}

const NONE: ChargeCostResult = {
  cost_amount: null,
  cost_currency: null,
  cost_source: 'computed',
  rate_applied: null,
}

/** Grid-side energy for per-kWh billing: prefer measured `used`, else `added`. */
function billableEnergy(addedKwh: number | null, usedKwh: number | null | undefined): number | null {
  if (usedKwh != null && addedKwh != null) return Math.max(usedKwh, addedKwh)
  return usedKwh ?? addedKwh ?? null
}

export function computeChargeCost(input: ChargeCostInput): ChargeCostResult {
  const { source, geofence, homeRate } = input

  if (source === 'supercharger') {
    if (input.freeSupercharging) {
      return {
        cost_amount: 0,
        cost_currency: geofence?.currency ?? homeRate?.currency ?? null,
        cost_source: 'tesla_billed_free',
        rate_applied: 0,
      }
    }
    // Paid Supercharger: authoritative cost comes from reconcile.ts.
    return NONE
  }

  // Geofence billing rule takes precedence over the bare home flat rate.
  if (geofence && geofence.cost_per_unit != null) {
    const rate = Number(geofence.cost_per_unit)
    const fee = geofence.session_fee != null ? Number(geofence.session_fee) : 0
    const currency = geofence.currency ?? homeRate?.currency ?? null
    if (geofence.billing_type === 'per_minute') {
      const minutes = input.durationS != null ? input.durationS / 60 : null
      const amount = minutes != null ? minutes * rate + fee : null
      return { cost_amount: amount, cost_currency: currency, cost_source: 'geofence', rate_applied: rate }
    }
    if (geofence.billing_type === 'per_session') {
      return { cost_amount: fee, cost_currency: currency, cost_source: 'geofence', rate_applied: null }
    }
    // per_kwh
    const energy = billableEnergy(input.energyAddedKwh, input.energyUsedKwh)
    const amount = energy != null ? energy * rate + fee : null
    return { cost_amount: amount, cost_currency: currency, cost_source: 'geofence', rate_applied: rate }
  }

  // A geofence with only a session_fee (no per-unit rate) → flat fee.
  if (geofence && geofence.session_fee != null) {
    return {
      cost_amount: Number(geofence.session_fee),
      cost_currency: geofence.currency ?? homeRate?.currency ?? null,
      cost_source: 'geofence',
      rate_applied: null,
    }
  }

  // Home flat-rate fallback (geofence.is_home or classified home, no per-zone rule).
  const home = geofence?.is_home || input.isHome
  if (home && homeRate?.flat_rate != null && input.energyAddedKwh) {
    const rate = Number(homeRate.flat_rate)
    const loss = Number(homeRate.loss_factor ?? 1.1)
    return {
      cost_amount: input.energyAddedKwh * rate * loss,
      cost_currency: homeRate.currency ?? null,
      cost_source: 'computed',
      rate_applied: rate,
    }
  }

  return NONE
}
