/**
 * Pure analytics builders for the battery-health, efficiency, mileage and
 * timeline views. No DB, no React — the server fns query rows and hand them
 * here, so the math is unit-testable (see analytics-vm.test.ts). Everything
 * speaks tesboard's canonical units (miles, °C, kWh, Wh/mi).
 */

/**
 * Usable pack capacity (kWh) implied by a rated-range reading: a car showing
 * `rangeMi` of rated range at `soc`% with efficiency `effWhPerMi` has a full-pack
 * capacity of range×eff / soc. Null when inputs are missing/zero.
 */
export function capacityKwh(
  rangeMi: number | null,
  soc: number | null,
  effWhPerMi: number | null,
): number | null {
  if (rangeMi == null || soc == null || effWhPerMi == null) return null
  if (!(soc > 0) || !(rangeMi > 0) || !(effWhPerMi > 0)) return null
  const energyAtSoc = (rangeMi * effWhPerMi) / 1000 // kWh currently in the pack
  return energyAtSoc / (soc / 100)
}

export interface CapacityPoint {
  date: string
  capacityKwh: number
}

export interface BatteryHealth {
  currentKwh: number | null
  maxKwh: number | null
  degradationPct: number | null
  series: CapacityPoint[]
}

/**
 * Battery health from capacity-over-time points. Current = mean of the most
 * recent `recentN`; Max = the historical peak (best observed ≈ original); the
 * degradation % is how far current sits below max.
 */
export function buildBatteryHealth(points: CapacityPoint[], recentN = 5): BatteryHealth {
  const series = [...points].sort((a, b) => (a.date < b.date ? -1 : 1))
  if (series.length === 0) return { currentKwh: null, maxKwh: null, degradationPct: null, series }
  const maxKwh = Math.max(...series.map((p) => p.capacityKwh))
  const recent = series.slice(-recentN)
  const currentKwh = recent.reduce((a, p) => a + p.capacityKwh, 0) / recent.length
  const degradationPct = maxKwh > 0 ? Math.max(0, 100 - (currentKwh * 100) / maxKwh) : null
  return { currentKwh, maxKwh, degradationPct, series }
}

/** Projected rated range at 100% SOC given pack capacity + efficiency. */
export function projectedRangeMi(capacityKwh: number | null, effWhPerMi: number | null): number | null {
  if (capacityKwh == null || effWhPerMi == null || !(effWhPerMi > 0)) return null
  return (capacityKwh * 1000) / effWhPerMi
}

export interface ConsumptionPoint {
  tempC: number
  whPerMi: number
}
export interface ConsumptionBin {
  tempC: number // bin centre
  avgWhPerMi: number
  count: number
}

/** Bin consumption-vs-temperature points into `binC`-wide temperature buckets. */
export function binConsumptionByTemp(points: ConsumptionPoint[], binC = 5): ConsumptionBin[] {
  const valid = points.filter(
    (p) => Number.isFinite(p.tempC) && Number.isFinite(p.whPerMi) && p.whPerMi > 0,
  )
  const buckets = new Map<number, { sum: number; count: number }>()
  for (const p of valid) {
    const centre = Math.round(p.tempC / binC) * binC
    const b = buckets.get(centre) ?? { sum: 0, count: 0 }
    b.sum += p.whPerMi
    b.count++
    buckets.set(centre, b)
  }
  return [...buckets.entries()]
    .map(([tempC, b]) => ({ tempC, avgWhPerMi: b.sum / b.count, count: b.count }))
    .sort((a, b) => a.tempC - b.tempC)
}

export type MileagePeriod = 'day' | 'week' | 'month' | 'year'
export interface MileageRow {
  started_at: string
  distance_mi: number | null
  end_odometer: number | null
}
export interface MileageBucket {
  period: string // ISO-ish bucket key
  distanceMi: number
  endOdometerMi: number | null
}

/** Bucket the start-of-period key for a date (UTC). */
export function periodKey(iso: string, period: MileagePeriod): string {
  const d = new Date(iso)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  if (period === 'year') return `${y}`
  if (period === 'month') return `${y}-${m}`
  if (period === 'week') {
    // ISO-ish: Monday-start week, keyed by that Monday's date.
    const dow = (d.getUTCDay() + 6) % 7 // 0=Mon
    const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - dow))
    return monday.toISOString().slice(0, 10)
  }
  return `${y}-${m}-${day}`
}

/** Sum distance + carry the last odometer per period bucket. */
export function bucketMileage(rows: MileageRow[], period: MileagePeriod): MileageBucket[] {
  const sorted = [...rows].sort((a, b) => (a.started_at < b.started_at ? -1 : 1))
  const map = new Map<string, MileageBucket>()
  for (const r of sorted) {
    const key = periodKey(r.started_at, period)
    const b = map.get(key) ?? { period: key, distanceMi: 0, endOdometerMi: null }
    if (r.distance_mi != null && r.distance_mi > 0) b.distanceMi += r.distance_mi
    if (r.end_odometer != null) b.endOdometerMi = r.end_odometer // sorted asc → last wins
    map.set(key, b)
  }
  return [...map.values()].sort((a, b) => (a.period < b.period ? -1 : 1))
}

export interface TimelineEvent {
  kind: 'drive' | 'charge' | 'state' | 'update'
  at: string
  title: string
  detail?: string
}

/** Merge heterogeneous events into one reverse-chronological log. */
export function mergeTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}
