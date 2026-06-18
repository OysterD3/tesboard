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

/**
 * Max rated range at 100% SOC implied by a `rangeMi`-at-`soc`% reading. Range
 * scales ~linearly with SOC, so the full-charge range is range × 100 / soc.
 * Unlike capacity this needs no efficiency factor, so the max-range trend still
 * works for vehicles whose Wh/mi hasn't been derived yet. Null on bad inputs.
 */
export function maxRangeMiAtFull(rangeMi: number | null, soc: number | null): number | null {
  if (rangeMi == null || soc == null) return null
  if (!(rangeMi > 0) || !(soc > 0)) return null
  return (rangeMi * 100) / soc
}

/** Mean of the most recent `n` finite values (chronological order assumed). */
export function recentMean(values: number[], n = 5): number | null {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return null
  const recent = v.slice(-n)
  return recent.reduce((a, b) => a + b, 0) / recent.length
}

export interface TrendLine {
  slope: number
  intercept: number
}

/**
 * Ordinary least-squares fit y = slope·x + intercept over the points. Returns
 * null with fewer than two finite points or a degenerate (zero-variance) x —
 * the degradation trend line drawn on the battery charts.
 */
export function linearRegression(points: { x: number; y: number }[]): TrendLine | null {
  const v = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const n = v.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const p of v) {
    sx += p.x
    sy += p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  return { slope, intercept }
}

// ── Battery health readings (capacity + max-range vs odometer) ─────────────────

/** A charge's post-charge readout, the input to a battery-health point. */
export interface ChargeCapRow {
  date: string // ended_at (ISO)
  endRangeMi: number | null
  endSoc: number | null
}
/** An odometer sample taken at a point in time (from drive endpoints). */
export interface OdoSample {
  at: string // ISO timestamp
  odometer: number // miles
}
/** A single battery-health reading plotted on the Capacity / Max-range charts. */
export interface BatteryReading {
  date: string
  odometerMi: number | null
  capacityKwh: number | null
  maxRangeMi: number | null
}

/**
 * Odometer (miles) at or before `iso` from time-sorted samples — the last sample
 * not after the moment. If the moment predates every sample (no drive recorded
 * yet) we fall back to the earliest known odometer. Null when there are none.
 */
export function odometerForTime(sortedOdo: OdoSample[], iso: string): number | null {
  if (sortedOdo.length === 0) return null
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return null
  let lo = 0
  let hi = sortedOdo.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (new Date(sortedOdo[mid].at).getTime() <= target) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans >= 0 ? sortedOdo[ans].odometer : sortedOdo[0].odometer
}

/**
 * Assemble battery-health readings: for each post-charge readout compute the
 * implied pack capacity (needs the efficiency factor) and the max range at 100%
 * (efficiency-free), and attach the odometer at the charge from the drive-derived
 * odometer timeline. Output is chronological. Pure — the server fn supplies rows.
 */
export function buildBatteryReadings(
  rows: ChargeCapRow[],
  odo: OdoSample[],
  effWhPerMi: number | null,
): BatteryReading[] {
  const sortedOdo = [...odo]
    .filter((s) => Number.isFinite(new Date(s.at).getTime()) && Number.isFinite(s.odometer))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  return rows
    .map((r) => ({
      date: r.date,
      odometerMi: odometerForTime(sortedOdo, r.date),
      capacityKwh: capacityKwh(r.endRangeMi, r.endSoc, effWhPerMi),
      maxRangeMi: maxRangeMiAtFull(r.endRangeMi, r.endSoc),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
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

export interface SpeedConsumptionPoint {
  speedMph: number
  whPerMi: number
}
export interface SpeedConsumptionBin {
  speedMph: number // bucket lower edge (mph)
  avgWhPerMi: number
  count: number
}

/**
 * Bin consumption-vs-speed points into `binMph`-wide buckets keyed by the
 * bucket's lower edge (0–10 mph → 0, 10–20 → 10, …). We bin on a drive's
 * AVERAGE speed (distance ÷ moving time), not its top speed: average tracks the
 * stop-and-go vs cruising character that actually drives Wh/mi, whereas a single
 * highway blip wouldn't characterise a city crawl. The server fn derives the
 * per-drive average speed and supplies the points.
 */
export function binConsumptionBySpeed(
  points: SpeedConsumptionPoint[],
  binMph = 10,
): SpeedConsumptionBin[] {
  const valid = points.filter(
    (p) =>
      Number.isFinite(p.speedMph) && p.speedMph >= 0 && Number.isFinite(p.whPerMi) && p.whPerMi > 0,
  )
  const buckets = new Map<number, { sum: number; count: number }>()
  for (const p of valid) {
    const edge = Math.floor(p.speedMph / binMph) * binMph
    const b = buckets.get(edge) ?? { sum: 0, count: 0 }
    b.sum += p.whPerMi
    b.count++
    buckets.set(edge, b)
  }
  return [...buckets.entries()]
    .map(([speedMph, b]) => ({ speedMph, avgWhPerMi: b.sum / b.count, count: b.count }))
    .sort((a, b) => a.speedMph - b.speedMph)
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

// ── Phantom / vampire standby loss ────────────────────────────────────────────

/** A snapshot row reduced to what standby-loss detection needs. */
export interface PhantomSnap {
  est: number | null // est_battery_range (mi)
  rng: number | null // battery_range (mi)
  charging: string | null // charging_state
  shift: string | null // shift_state
  at: string // recorded_at ISO
}
export interface PhantomDay {
  date: string // YYYY-MM-DD (UTC)
  lostMi: number
}
export interface PhantomDrainResult {
  hasData: boolean
  lostMi: number
  perDayMi: number
  days: number
  /** Per-UTC-day standby loss, chronological — drives the trend sparkline. */
  series: PhantomDay[]
}

/**
 * Standby (vampire) range loss from consecutive snapshots: range that drops
 * between two readings where the car is parked (no/Park shift) and not charging
 * is standby loss. Single-step drops larger than `maxIntervalDropMi` are treated
 * as data gaps / noise, not standby. Pure — the server fn queries the rows.
 */
export function buildPhantomDrain(snaps: PhantomSnap[], maxIntervalDropMi = 10): PhantomDrainResult {
  const empty: PhantomDrainResult = { hasData: false, lostMi: 0, perDayMi: 0, days: 0, series: [] }
  if (snaps.length < 2) return empty

  const range = (s: PhantomSnap) => s.est ?? s.rng
  const parkedUnplugged = (s: PhantomSnap) =>
    (s.shift == null || s.shift === 'P') && s.charging !== 'Charging'

  const perDay = new Map<string, number>()
  let lostMi = 0
  let firstMs: number | null = null
  let lastMs = 0
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1]
    const b = snaps[i]
    const t = new Date(b.at).getTime()
    if (firstMs == null) firstMs = new Date(a.at).getTime()
    lastMs = t
    const ra = range(a)
    const rb = range(b)
    if (ra == null || rb == null) continue
    if (!parkedUnplugged(a) || !parkedUnplugged(b)) continue
    const drop = ra - rb
    if (drop > 0 && drop <= maxIntervalDropMi) {
      lostMi += drop
      const day = b.at.slice(0, 10) // ISO date (UTC) bucket
      perDay.set(day, (perDay.get(day) ?? 0) + drop)
    }
  }

  if (lostMi <= 0 || firstMs == null) return empty
  const spanDays = Math.max(1, (lastMs - firstMs) / 86_400_000)
  const round1 = (n: number) => Math.round(n * 10) / 10
  const series = [...perDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, mi]) => ({ date, lostMi: round1(mi) }))
  return {
    hasData: true,
    lostMi: round1(lostMi),
    perDayMi: round1(lostMi / spanDays),
    days: Math.round(spanDays),
    series,
  }
}

// ── Phantom / vampire loss cause attribution ──────────────────────────────────

export type PhantomCause = 'sentry' | 'climate' | 'cold' | 'awake' | 'asleep'

/** A snapshot row reduced to what cause attribution needs. */
export interface PhantomCauseSnap extends PhantomSnap {
  outsideC: number | null
  sentry: boolean | null
  climateOn: boolean | null // is_climate_on OR is_preconditioning
}
export interface PhantomCauseSlice {
  cause: PhantomCause
  lostMi: number
  pct: number
}
export interface PhantomCausesResult {
  hasData: boolean
  totalMi: number
  slices: PhantomCauseSlice[]
}

const PHANTOM_AWAKE_GAP_MIN = 12 // gap > this between samples ⇒ the car slept in between
const PHANTOM_COLD_C = 5 // at/below this outside temp, attribute otherwise-idle loss to cold

/**
 * Attribute standby (vampire) range loss to a likely cause, per parked+unplugged
 * interval. This is a correlation heuristic — Tesla exposes no per-subsystem
 * energy — so each loss slice is tagged by what was active over that interval,
 * by priority: a sleep gap (asleep baseline) → Sentry → climate/preconditioning
 * → cold ambient → awake-but-idle. Pure; the server fn supplies the rows.
 */
export function buildPhantomCauses(
  snaps: PhantomCauseSnap[],
  maxIntervalDropMi = 10,
): PhantomCausesResult {
  const range = (s: PhantomCauseSnap) => s.est ?? s.rng
  const parkedUnplugged = (s: PhantomCauseSnap) =>
    (s.shift == null || s.shift === 'P') && s.charging !== 'Charging'

  const totals = new Map<PhantomCause, number>()
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1]
    const b = snaps[i]
    if (!parkedUnplugged(a) || !parkedUnplugged(b)) continue
    const ra = range(a)
    const rb = range(b)
    if (ra == null || rb == null) continue
    const drop = ra - rb
    if (!(drop > 0 && drop <= maxIntervalDropMi)) continue

    const gapMin = (new Date(b.at).getTime() - new Date(a.at).getTime()) / 60_000
    let cause: PhantomCause
    if (gapMin > PHANTOM_AWAKE_GAP_MIN) cause = 'asleep'
    else if (a.sentry || b.sentry) cause = 'sentry'
    else if (a.climateOn || b.climateOn) cause = 'climate'
    else if (b.outsideC != null && b.outsideC <= PHANTOM_COLD_C) cause = 'cold'
    else cause = 'awake'
    totals.set(cause, (totals.get(cause) ?? 0) + drop)
  }

  const totalMi = [...totals.values()].reduce((a, b) => a + b, 0)
  if (totalMi <= 0) return { hasData: false, totalMi: 0, slices: [] }
  const round1 = (n: number) => Math.round(n * 10) / 10
  const slices = [...totals.entries()]
    .map(([cause, mi]) => ({ cause, lostMi: round1(mi), pct: Math.round((mi / totalMi) * 100) }))
    .sort((a, b) => b.lostMi - a.lostMi)
  return { hasData: true, totalMi: round1(totalMi), slices }
}

// ── Charging energy / measured AC loss ────────────────────────────────────────

/** A charge snapshot reduced to grid-power integration inputs. */
export interface ChargePowerSample {
  at: string // recorded_at ISO
  voltage: number | null // charger_voltage (V)
  current: number | null // charger_actual_current (A)
  phases: number | null // charger_phases
}

/**
 * Sum `charge_energy_added` (kWh) across genuine charge resets within a session
 * window. The counter rises monotonically during a single charge and resets
 * toward zero at each new physical charge, so we bank the peak of each segment.
 *
 * A reset is a LARGE fractional drop (next reading < half the running peak) — not
 * any decrease. Treating every sample-to-sample dip as a reset (the old bug)
 * re-banked the running peak on rounding noise and inflated a normal ~40 kWh
 * charge into hundreds of kWh. Returns null when there are no readings.
 */
export function sumChargeEnergyAdded(energies: number[]): number | null {
  const vals = energies.filter((e) => Number.isFinite(e) && e >= 0)
  if (!vals.length) return null
  let total = 0
  let segPeak = 0
  let prev = -Infinity
  for (const e of vals) {
    if (prev > 1 && e < prev * 0.5) {
      // genuine reset → bank the finished segment, start a new one
      total += segPeak
      segPeak = e
    } else {
      segPeak = Math.max(segPeak, e)
    }
    prev = e
  }
  return total + segPeak
}

export interface ChargeCycleResult {
  /** Equivalent full cycles (lifetime energy ÷ pack capacity); null if no pack. */
  cycles: number | null
  /** Lifetime energy added to the battery across all charges (kWh). */
  energyTotalKwh: number | null
}

/**
 * Equivalent full charge cycles = total energy added to the pack across every
 * charge ÷ usable pack capacity. A "cycle" is energy-equivalent (one pack's
 * worth of charge), not a plug-in count — ten 10% top-ups make one cycle, which
 * is the wear-relevant figure. Each input is one charge session's *own* total
 * `energy_added_kwh` (already reset-resolved at sessionization), so this is a
 * plain sum — NOT sumChargeEnergyAdded, which banks peaks within a single
 * session's monotonic snapshot stream. Cycles is null when pack capacity is
 * unknown; the energy total is still returned so the UI can show lifetime kWh.
 */
export function buildChargeCycleCount(
  energiesPerCharge: number[],
  packKwh: number | null,
): ChargeCycleResult {
  const vals = energiesPerCharge.filter((e) => Number.isFinite(e) && e > 0)
  if (!vals.length) return { cycles: null, energyTotalKwh: null }
  const energyTotalKwh = vals.reduce((a, b) => a + b, 0)
  if (packKwh == null || !(packKwh > 0)) return { cycles: null, energyTotalKwh }
  return { cycles: energyTotalKwh / packKwh, energyTotalKwh }
}

/**
 * Grid-side energy (kWh) drawn over an AC charge, trapezoid-integrating the
 * instantaneous apparent power P = V × A × phases across the snapshot timeline.
 * Returns null when fewer than two samples carry valid V/A/phases. This is an
 * approximation at the 2-min poll cadence (and Tesla's `charger_phases` is a
 * known-quirky field), so callers should clamp the derived loss to a sane band.
 */
export function integrateGridEnergyKwh(samples: ChargePowerSample[]): number | null {
  const pts = samples
    .filter((s) => s.voltage != null && s.current != null && s.phases != null && s.phases > 0)
    .map((s) => ({ t: new Date(s.at).getTime(), w: s.voltage! * s.current! * s.phases! }))
    .filter((p) => Number.isFinite(p.t) && p.w >= 0)
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) return null
  let wh = 0
  for (let i = 1; i < pts.length; i++) {
    const dtH = (pts[i].t - pts[i - 1].t) / 3_600_000
    if (dtH <= 0) continue
    wh += ((pts[i].w + pts[i - 1].w) / 2) * dtH
  }
  return wh / 1000
}

/**
 * Measured charge loss %: how much more energy was drawn from the source than
 * landed in the battery — (grid − battery) / grid. Returns null outside a
 * believable [0, 40]% band so a bad sample (or the phases quirk) never shows a
 * nonsense figure.
 */
export function measuredLossPct(gridKwh: number | null, batteryKwh: number | null): number | null {
  if (gridKwh == null || batteryKwh == null) return null
  if (!(gridKwh > 0) || !(batteryKwh > 0)) return null
  const loss = ((gridKwh - batteryKwh) / gridKwh) * 100
  if (loss < 0 || loss > 40) return null
  return Math.round(loss * 10) / 10
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
