/**
 * Pure view-model for a single drive's detail page. The server fn
 * (drive-detail.functions.ts) queries the drive row + its per-sample telemetry
 * and hands the raw payload here; this turns it into display-ready stats and
 * chart series in the design's canonical units (distance km, speed km/h, temp
 * °C, elevation m, energy kWh). The route applies the user's unit selection at
 * the formatter boundary, exactly like dashboard-vm.ts.
 *
 * No React / no server imports — unit-testable (see drive-detail-vm.test.ts).
 */
import type { DriveDetailPayload } from '../functions/drive-detail.functions'

const KM_PER_MI = 1.60934
const miToKm = (mi: number) => mi * KM_PER_MI
const whPerMiToWhKm = (wpm: number) => wpm / KM_PER_MI

function round(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

export interface Pt {
  /** Elapsed minutes from the drive start. */
  x: number
  y: number
}

export interface DriveDetailSeries {
  /** Battery state-of-charge (%) over time. */
  battery: Pt[]
  /** Speed (km/h, canonical) over time. */
  speedKph: Pt[]
  /** Elevation (m) over time. */
  elevationM: Pt[]
  /** Cabin (interior) temperature (°C) over time. */
  insideC: Pt[]
  /** Outside (exterior) temperature (°C) over time. */
  outsideC: Pt[]
  /** Instantaneous drive power (kW) over time; negative = regen. */
  powerKw: Pt[]
}

export interface DriveDetailVM {
  found: boolean
  title: string
  /** Date + time range, e.g. "Jun 18 · 2:05 – 2:51 PM". */
  subtitle: string
  startPlace: string | null
  endPlace: string | null
  /** "Mon, Apr 20 · 7:14 PM" for each endpoint (tz-safe). */
  startStamp: string
  endStamp: string | null
  distKm: number
  durMin: number
  avgKph: number
  maxKph: number | null
  kwh: number | null
  /** Drive consumption in Wh/km (canonical); null when not computed. */
  effWhKm: number | null
  batteryStart: number | null
  batteryEnd: number | null
  /** Total climb / descent over the drive (m). */
  ascentM: number | null
  descentM: number | null
  /** Highest elevation reached (m), from the sample stream. */
  peakElevM: number | null
  insideAvgC: number | null
  outsideAvgC: number | null
  /** Peak drive power (kW) observed over the drive. */
  peakPowerKw: number | null
  /** Peak regen power (kW, positive magnitude) — the strongest negative power. */
  peakRegenKw: number | null
  /** Rated range consumed over the drive (km), from the SOC range readings. */
  ratedUsedKm: number | null
  /** Range efficiency: actual distance ÷ rated range used, as a percent. */
  rangeEffPct: number | null
  /** Estimated energy cost (energy × rate × loss); null when no rate configured. */
  estCost: { amount: number; currency: string } | null
  hasGps: boolean
  series: DriveDetailSeries
}

const EMPTY_SERIES: DriveDetailSeries = {
  battery: [],
  speedKph: [],
  elevationM: [],
  insideC: [],
  outsideC: [],
  powerKw: [],
}

/**
 * Evenly stride `rows` down to at most `max` items, always keeping the first and
 * last (so a chart's endpoints stay anchored). Returns a copy; consecutive
 * duplicates introduced by rounding are dropped. Used server-side to bound the
 * per-sample payload of long imported drives.
 */
export function downsampleSeries<T>(rows: T[], max: number): T[] {
  if (max < 2 || rows.length <= max) return rows.slice()
  const out: T[] = []
  const step = (rows.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)])
  return out.filter((v, i) => i === 0 || v !== out[i - 1])
}

/** "0m" / "12m" / "1h 4m" — tz-independent elapsed-time label. */
export function fmtElapsedMin(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

/**
 * Absolute "Jun 18, 2:05 PM" label for a chart x value. `ms` is a real epoch
 * timestamp (the drive start + the sample's elapsed minutes); `tz` is 'UTC'
 * during SSR / first client render so the label can't shift between them.
 */
export function fmtClockStamp(ms: number, tz?: string): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${day}, ${time}`
}

/** Cumulative climb/descent (m) over an elevation series, or null if too short. */
function cumulativeElevation(points: Pt[]): { ascent: number; descent: number } | null {
  if (points.length < 2) return null
  let ascent = 0
  let descent = 0
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].y - points[i - 1].y
    if (delta > 0) ascent += delta
    else descent -= delta
  }
  return { ascent: Math.round(ascent), descent: Math.round(descent) }
}

function dayLabel(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
}
/** "Mon, Apr 20 · 7:14 PM" — weekday + date + time for a trip endpoint (tz-safe). */
function stamp(iso: string, tz?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz })
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  const tm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${wd}, ${md} · ${tm}`
}
function clock(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

export function buildDriveDetail(p: DriveDetailPayload, tz?: string): DriveDetailVM {
  const d = p.drive
  if (!d) {
    return {
      found: false,
      title: 'Drive',
      subtitle: '',
      startPlace: null,
      endPlace: null,
      startStamp: '',
      endStamp: null,
      distKm: 0,
      durMin: 0,
      avgKph: 0,
      maxKph: null,
      kwh: null,
      effWhKm: null,
      batteryStart: null,
      batteryEnd: null,
      ascentM: null,
      descentM: null,
      peakElevM: null,
      insideAvgC: null,
      outsideAvgC: null,
      peakPowerKw: null,
      peakRegenKw: null,
      ratedUsedKm: null,
      rangeEffPct: null,
      estCost: null,
      hasGps: false,
      series: EMPTY_SERIES,
    }
  }

  const distKm = d.distance_mi != null ? miToKm(d.distance_mi) : 0
  const durMin = d.duration_s != null ? Math.round(d.duration_s / 60) : 0
  const hours = d.duration_s != null && d.duration_s > 0 ? d.duration_s / 3600 : 0
  const avgKph = hours > 0 && d.distance_mi != null ? round(miToKm(d.distance_mi) / hours) : 0

  const series: DriveDetailSeries = {
    battery: p.samples.filter((s) => s.battery != null).map((s) => ({ x: s.tMin, y: s.battery as number })),
    speedKph: p.samples
      .filter((s) => s.speedMph != null)
      .map((s) => ({ x: s.tMin, y: round((s.speedMph as number) * KM_PER_MI, 1) })),
    elevationM: p.samples.filter((s) => s.elevationM != null).map((s) => ({ x: s.tMin, y: s.elevationM as number })),
    insideC: p.samples.filter((s) => s.insideC != null).map((s) => ({ x: s.tMin, y: s.insideC as number })),
    outsideC: p.samples.filter((s) => s.outsideC != null).map((s) => ({ x: s.tMin, y: s.outsideC as number })),
    powerKw: p.samples.filter((s) => s.powerKw != null).map((s) => ({ x: s.tMin, y: s.powerKw as number })),
  }

  // Max speed: prefer the drive's recorded peak, else the highest sample.
  let maxMph = d.speed_max_mph ?? -Infinity
  for (const s of p.samples) if (s.speedMph != null && s.speedMph > maxMph) maxMph = s.speedMph
  const maxKph = Number.isFinite(maxMph) ? round(maxMph * KM_PER_MI) : null

  // Power: prefer the drive's stored peaks (imported drives), else the sample
  // extremes (live). Peak regen is the most negative power, shown as a magnitude.
  let maxPow = d.power_max_kw ?? -Infinity
  let minPow = d.power_min_kw ?? Infinity
  for (const s of p.samples) {
    if (s.powerKw == null) continue
    if (s.powerKw > maxPow) maxPow = s.powerKw
    if (s.powerKw < minPow) minPow = s.powerKw
  }
  const peakPowerKw = Number.isFinite(maxPow) ? round(maxPow) : null
  const peakRegenKw = Number.isFinite(minPow) && minPow < 0 ? round(-minPow) : null

  const peakElevM = series.elevationM.length ? Math.max(...series.elevationM.map((q) => q.y)) : null
  // Imported drives carry authoritative ascent/descent (dense source data); for
  // live-polled drives those are null, so derive them from the (backfilled)
  // elevation samples — coarse at the poll cadence, but keeps the stat in step
  // with the chart instead of showing nothing.
  const cumElev = cumulativeElevation(series.elevationM)

  // Range efficiency: how the rated range the car gave up compares to the
  // distance actually driven (Tessie's "efficiency %"). >100% = better than rated.
  const ratedUsedMi = d.start_range_mi != null && d.end_range_mi != null ? d.start_range_mi - d.end_range_mi : null
  const ratedUsedKm = ratedUsedMi != null && ratedUsedMi > 0 ? round(miToKm(ratedUsedMi), 1) : null
  const rangeEffPct = ratedUsedKm != null && ratedUsedKm > 0 && distKm > 0 ? Math.round((distKm / ratedUsedKm) * 100) : null

  const s = d.startLocation
  const e = d.endLocation
  const place = s && e ? (s === e ? s : `${s} → ${e}`) : e || s || null

  const sDay = dayLabel(d.started_at, tz)
  const sClock = clock(d.started_at, tz)
  const eDay = d.ended_at ? dayLabel(d.ended_at, tz) : null
  const eClock = d.ended_at ? clock(d.ended_at, tz) : null
  const subtitle = d.ended_at
    ? sDay === eDay
      ? `${sDay} · ${sClock} – ${eClock}`
      : `${sDay} ${sClock} – ${eDay} ${eClock}`
    : `${sDay} · ${sClock}`

  return {
    found: true,
    title: place ?? `${sDay} · ${sClock}`,
    subtitle,
    startPlace: s,
    endPlace: e,
    startStamp: stamp(d.started_at, tz),
    endStamp: d.ended_at ? stamp(d.ended_at, tz) : null,
    distKm: round(distKm, 1),
    durMin,
    avgKph,
    maxKph,
    kwh: d.energy_used_kwh != null ? round(d.energy_used_kwh, 1) : null,
    effWhKm: d.wh_per_mi != null && d.wh_per_mi > 0 ? round(whPerMiToWhKm(d.wh_per_mi)) : null,
    batteryStart: d.start_battery_level,
    batteryEnd: d.end_battery_level,
    ascentM: d.ascent ?? cumElev?.ascent ?? null,
    descentM: d.descent ?? cumElev?.descent ?? null,
    peakElevM,
    insideAvgC: d.inside_temp_avg,
    outsideAvgC: d.outside_temp_avg,
    peakPowerKw,
    peakRegenKw,
    ratedUsedKm,
    rangeEffPct,
    estCost: p.estCost ? { amount: round(p.estCost.amount, 2), currency: p.estCost.currency } : null,
    hasGps: p.points.length >= 1,
    series,
  }
}
