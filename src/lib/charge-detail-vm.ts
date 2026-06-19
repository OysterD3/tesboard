/**
 * Pure view-model for a single charge's detail page. The server fn
 * (charge-detail.functions.ts) queries the charge row + its per-sample telemetry
 * and hands the raw payload here; this turns it into display-ready stats and
 * chart series in the design's canonical units (range km, temp °C, energy kWh,
 * power kW, current A, voltage V). The route applies the user's unit selection at
 * the formatter boundary, exactly like drive-detail-vm.ts.
 *
 * No React / no server imports — unit-testable (see charge-detail-vm.test.ts).
 */
import type { ChargeDetailPayload } from '../functions/charge-detail.functions'
import type { Pt } from './drive-detail-vm'

const KM_PER_MI = 1.60934
const miToKm = (mi: number) => mi * KM_PER_MI

function round(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export interface ChargeDetailSeries {
  /** State of charge (%) over time. */
  soc: Pt[]
  /** Rated range (km, canonical) over time. */
  rangeKm: Pt[]
  /** Charge power (kW) over time. */
  powerKw: Pt[]
  /** Charger current (A) over time. */
  currentA: Pt[]
  /** Charger voltage (V) over time. */
  voltageV: Pt[]
  /** Cabin (interior) temperature (°C) over time. */
  insideC: Pt[]
  /** Outside (exterior) temperature (°C) over time. */
  outsideC: Pt[]
}

export interface ChargeDetailVM {
  found: boolean
  title: string
  /** Date + time range, e.g. "Apr 18 · 5:20 – 5:32 PM". */
  subtitle: string
  place: string | null
  /** "Sat, Apr 18 · 5:20 PM" for each end (tz-safe); endStamp null while charging. */
  startStamp: string | null
  endStamp: string | null
  /** Supercharger (DC) vs AC. */
  isFast: boolean
  typeLabel: string
  batteryStart: number | null
  batteryEnd: number | null
  /** Authoritative/estimated session cost (from the charge row). */
  cost: { amount: number; currency: string } | null
  costSource: string
  /** Odometer at the charge (km); null when no preceding drive odometer is known. */
  odometerKm: number | null
  /** Distance driven since the previous charge (km); null when not derivable. */
  sinceLastChargeKm: number | null
  durMin: number
  /** Grid energy drawn (kWh); null on live AC charges that don't store it. */
  usedKwh: number | null
  /** Battery energy added (kWh). */
  addedKwh: number | null
  /** Charging efficiency: added ÷ used, as a percent; null when used isn't known. */
  effPct: number | null
  /** Rated range added over the session (km). */
  rangeAddedKm: number | null
  powerAvgKw: number | null
  powerPeakKw: number | null
  currentAvgA: number | null
  currentPeakA: number | null
  voltageAvgV: number | null
  voltagePeakV: number | null
  insideAvgC: number | null
  outsideAvgC: number | null
  hasMap: boolean
  series: ChargeDetailSeries
}

const EMPTY_SERIES: ChargeDetailSeries = {
  soc: [],
  rangeKm: [],
  powerKw: [],
  currentA: [],
  voltageV: [],
  insideC: [],
  outsideC: [],
}

/** Mean of the present (finite) y-values, rounded to `d`; null when none. */
function avg(points: Pt[], d = 0): number | null {
  if (points.length === 0) return null
  let sum = 0
  for (const p of points) sum += p.y
  return round(sum / points.length, d)
}
/** Max y-value, rounded; null when empty. */
function peak(points: Pt[], d = 0): number | null {
  if (points.length === 0) return null
  return round(Math.max(...points.map((p) => p.y)), d)
}

function dayLabel(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
}
/** "Sat, Apr 18 · 5:20 PM" — weekday + date + time for an endpoint (tz-safe). */
function stamp(iso: string | null, tz?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz })
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  const tm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${wd}, ${md} · ${tm}`
}
function clock(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

export function buildChargeDetail(p: ChargeDetailPayload, tz?: string): ChargeDetailVM {
  const c = p.charge
  if (!c) {
    return {
      found: false,
      title: 'Charge',
      subtitle: '',
      place: null,
      startStamp: null,
      endStamp: null,
      isFast: false,
      typeLabel: 'AC',
      batteryStart: null,
      batteryEnd: null,
      cost: null,
      costSource: 'computed',
      odometerKm: null,
      sinceLastChargeKm: null,
      durMin: 0,
      usedKwh: null,
      addedKwh: null,
      effPct: null,
      rangeAddedKm: null,
      powerAvgKw: null,
      powerPeakKw: null,
      currentAvgA: null,
      currentPeakA: null,
      voltageAvgV: null,
      voltagePeakV: null,
      insideAvgC: null,
      outsideAvgC: null,
      hasMap: false,
      series: EMPTY_SERIES,
    }
  }

  const series: ChargeDetailSeries = {
    soc: p.samples.filter((s) => s.soc != null).map((s) => ({ x: s.tMin, y: s.soc as number })),
    rangeKm: p.samples
      .filter((s) => s.rangeMi != null)
      .map((s) => ({ x: s.tMin, y: round(miToKm(s.rangeMi as number), 1) })),
    powerKw: p.samples.filter((s) => s.powerKw != null).map((s) => ({ x: s.tMin, y: s.powerKw as number })),
    currentA: p.samples.filter((s) => s.currentA != null).map((s) => ({ x: s.tMin, y: s.currentA as number })),
    voltageV: p.samples.filter((s) => s.voltageV != null).map((s) => ({ x: s.tMin, y: s.voltageV as number })),
    insideC: p.samples.filter((s) => s.insideC != null).map((s) => ({ x: s.tMin, y: s.insideC as number })),
    outsideC: p.samples.filter((s) => s.outsideC != null).map((s) => ({ x: s.tMin, y: s.outsideC as number })),
  }

  const durMin =
    c.ended_at != null
      ? Math.max(0, Math.round((new Date(c.ended_at).getTime() - new Date(c.started_at).getTime()) / 60000))
      : 0

  const addedKwh = c.energy_added_kwh != null ? round(c.energy_added_kwh, 2) : null
  const usedKwh = c.energy_used_kwh != null ? round(c.energy_used_kwh, 2) : null
  // Charging efficiency = battery energy added ÷ grid energy drawn. AC charging
  // loses ~10%; null when the grid figure isn't known (most live AC sessions).
  const effPct =
    c.energy_added_kwh != null && c.energy_used_kwh != null && c.energy_used_kwh > 0
      ? round((c.energy_added_kwh / c.energy_used_kwh) * 100)
      : null

  const rangeAddedMi =
    c.start_range_mi != null && c.end_range_mi != null ? c.end_range_mi - c.start_range_mi : null
  const rangeAddedKm = rangeAddedMi != null && rangeAddedMi > 0 ? round(miToKm(rangeAddedMi), 1) : null

  // Exterior temp falls back to the stored session average when there are no samples.
  const outsideAvgC = series.outsideC.length ? avg(series.outsideC, 1) : c.outside_temp_avg ?? null

  const place = c.locationName
  const sDay = dayLabel(c.started_at, tz)
  const sClock = clock(c.started_at, tz)
  const eDay = c.ended_at ? dayLabel(c.ended_at, tz) : null
  const eClock = c.ended_at ? clock(c.ended_at, tz) : null
  const subtitle = c.ended_at
    ? sDay === eDay
      ? `${sDay} · ${sClock} – ${eClock}`
      : `${sDay} ${sClock} – ${eDay} ${eClock}`
    : `${sDay} · ${sClock}`

  const isFast = c.source === 'supercharger'

  return {
    found: true,
    // Neutral fallback when no place resolves — the subtitle already carries the
    // date/time range, so a date title here would just duplicate it.
    title: place ?? 'Charge session',
    subtitle,
    place,
    startStamp: stamp(c.started_at, tz),
    endStamp: stamp(c.ended_at, tz),
    isFast,
    typeLabel: isFast ? 'DC fast' : 'AC',
    batteryStart: c.start_battery_level,
    batteryEnd: c.end_battery_level,
    cost: c.cost_amount != null ? { amount: round(c.cost_amount, 2), currency: c.cost_currency ?? 'USD' } : null,
    costSource: c.cost_source ?? 'computed',
    odometerKm: p.odometerMi != null ? round(miToKm(p.odometerMi), 1) : null,
    sinceLastChargeKm: p.sinceLastChargeMi != null ? round(miToKm(p.sinceLastChargeMi), 1) : null,
    durMin,
    usedKwh,
    addedKwh,
    effPct,
    rangeAddedKm,
    powerAvgKw: avg(series.powerKw),
    powerPeakKw: peak(series.powerKw),
    currentAvgA: avg(series.currentA),
    currentPeakA: peak(series.currentA),
    voltageAvgV: avg(series.voltageV),
    voltagePeakV: peak(series.voltageV),
    insideAvgC: avg(series.insideC, 1),
    outsideAvgC,
    hasMap: p.point != null,
    series,
  }
}
