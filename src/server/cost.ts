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
import type { BillingType, CostSource, Json } from '../types/db'

/**
 * Time-of-use tariff. A band applies when the charge time (converted to local
 * wall-clock via `utcOffsetMin`) falls in [startMin, endMin) minutes-of-day and
 * the weekday is in `days` (empty = every day). Bands are first-match-wins;
 * unmatched minutes fall back to `defaultRate`. Cost over a charge window is the
 * time-weighted average rate × energy × loss (energy allocated proportional to
 * time, since the Fleet poll gives no per-minute kWh). DST shifts within a single
 * session are not modelled — the fixed offset is applied across the window.
 */
export interface TouBand {
  name: string
  rate: number
  /** Minutes-of-day, 0–1440. Wraps past midnight when startMin > endMin. */
  startMin: number
  endMin: number
  /** Weekdays this band applies to (0=Sun…6=Sat). Empty/omitted = all days. */
  days?: number[]
}

export interface TouSchedule {
  bands: TouBand[]
  /** $/kWh applied to minutes no band covers. Null = those minutes are skipped. */
  defaultRate: number | null
  /** Minutes east of UTC for the user's local time (e.g. -420 for PDT). */
  utcOffsetMin?: number
}

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
  /** Optional time-of-use schedule; takes precedence over flat_rate when present. */
  tou?: TouSchedule | null
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
  /** Charge window (ISO) — only needed to weight a time-of-use tariff. */
  startedAt?: string | null
  endedAt?: string | null
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

/** True when local minute-of-day `m` (and weekday `dow`) fall inside a band. */
function bandCovers(band: TouBand, dow: number, m: number): boolean {
  if (band.days && band.days.length > 0 && !band.days.includes(dow)) return false
  const { startMin, endMin } = band
  if (startMin === endMin) return true // full-day band
  return startMin < endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin
}

/** First-match band rate at a given UTC instant, or the schedule's default. */
function rateAtInstant(schedule: TouSchedule, utcMs: number): number | null {
  const localMs = utcMs + (schedule.utcOffsetMin ?? 0) * 60_000
  const d = new Date(localMs)
  const dow = d.getUTCDay()
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  for (const b of schedule.bands) if (bandCovers(b, dow, m)) return b.rate
  return schedule.defaultRate ?? null
}

/**
 * Time-weighted average $/kWh across [startISO, endISO). Samples per-minute
 * (capped at 14 days) so a session straddling band boundaries is split correctly.
 * Returns null if no minute resolves to a rate. With no/zero-length window, uses
 * the rate at the start instant.
 */
export function touWeightedRate(
  schedule: TouSchedule,
  startISO: string | null | undefined,
  endISO: string | null | undefined,
): number | null {
  if (!startISO) return null
  const startMs = new Date(startISO).getTime()
  if (Number.isNaN(startMs)) return null
  const endMs = endISO ? new Date(endISO).getTime() : startMs
  const totalMin = Math.max(1, Math.round((endMs - startMs) / 60_000))
  const cap = Math.min(totalMin, 14 * 24 * 60)
  let sum = 0
  let n = 0
  for (let i = 0; i < cap; i++) {
    const r = rateAtInstant(schedule, startMs + i * 60_000)
    if (r != null) {
      sum += r
      n++
    }
  }
  return n > 0 ? sum / n : null
}

/** Validate/normalize the jsonb `tou_schedule` into a TouSchedule, or null. */
export function parseTouSchedule(json: Json | null | undefined): TouSchedule | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const obj = json as Record<string, Json>
  const rawBands = Array.isArray(obj.bands) ? obj.bands : []
  const bands: TouBand[] = []
  for (const b of rawBands) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue
    const o = b as Record<string, Json>
    const rate = typeof o.rate === 'number' ? o.rate : Number(o.rate)
    const startMin = typeof o.startMin === 'number' ? o.startMin : Number(o.startMin)
    const endMin = typeof o.endMin === 'number' ? o.endMin : Number(o.endMin)
    if (![rate, startMin, endMin].every((n) => Number.isFinite(n))) continue
    const days = Array.isArray(o.days)
      ? o.days.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
      : undefined
    bands.push({ name: typeof o.name === 'string' ? o.name : 'Band', rate, startMin, endMin, days })
  }
  const defaultRate = typeof obj.defaultRate === 'number' ? obj.defaultRate : null
  if (bands.length === 0 && defaultRate == null) return null
  const utcOffsetMin = typeof obj.utcOffsetMin === 'number' ? obj.utcOffsetMin : 0
  return { bands, defaultRate, utcOffsetMin }
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

  // Home (geofence.is_home or classified home, no per-zone rule).
  const home = geofence?.is_home || input.isHome
  if (home && homeRate && input.energyAddedKwh) {
    const loss = Number(homeRate.loss_factor ?? 1.1)

    // Time-of-use takes precedence over the bare flat rate when configured.
    if (homeRate.tou) {
      const weighted = touWeightedRate(homeRate.tou, input.startedAt, input.endedAt)
      if (weighted != null) {
        return {
          cost_amount: input.energyAddedKwh * weighted * loss,
          cost_currency: homeRate.currency ?? null,
          cost_source: 'computed',
          rate_applied: Math.round(weighted * 1e6) / 1e6,
        }
      }
    }

    if (homeRate.flat_rate != null) {
      const rate = Number(homeRate.flat_rate)
      return {
        cost_amount: input.energyAddedKwh * rate * loss,
        cost_currency: homeRate.currency ?? null,
        cost_source: 'computed',
        rate_applied: rate,
      }
    }
  }

  return NONE
}
