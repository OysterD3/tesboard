/**
 * Dashboard view-models — strictly live data, no seed/mock. DB rows (stored in
 * miles / Wh-per-mile) are normalised into the design's canonical units (distance
 * in km, efficiency in Wh/km). Anything not present in the data is `null`, and the
 * views render an honest empty state rather than a placeholder number.
 *
 * Pure module (no React / no server imports) — safe to use in the browser.
 */
import type { OverviewPayload } from '../functions/overview.functions'
import type { DrivesPayload } from '../functions/drives.functions'
import type { ChargingPayload } from '../functions/charging.functions'
import type { DepartureReadinessPayload } from '../functions/readiness.functions'
import type { PhantomDrain } from '../functions/insights.functions'

const KM_PER_MI = 1.60934
const miToKm = (mi: number) => mi * KM_PER_MI
const whPerMiToWhKm = (wpm: number) => wpm / KM_PER_MI

function round(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Format a timestamp as "Today/Yesterday/Mon D · h:mm AM" in time zone `tz`.
 * `tz` is undefined for the runtime's local zone, or 'UTC' during SSR / first
 * client render so server and client agree (see useDisplayTz / hydration note).
 * The day comparison is done in the SAME zone (en-CA → YYYY-MM-DD) so the
 * Today/Yesterday label can't flip between server and client.
 */
function fmtWhen(iso: string | null, tz?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const dayKey = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: tz })
  const dk = dayKey(d)
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000))
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  if (dk === today) return `Today · ${time}`
  if (dk === yesterday) return `Yesterday · ${time}`
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  return `${date} · ${time}`
}

/**
 * Stable month bucket for grouping/filtering long lists. `monthKey` (YYYY-MM) is
 * the machine key; `monthLabel` ("May 2026") is for display. Computed in `tz` (same
 * zone the rows are formatted in) so the bucket can't drift between server/client.
 */
function monthParts(iso: string | null, tz?: string): { monthKey: string; monthLabel: string } {
  if (!iso) return { monthKey: 'unknown', monthLabel: 'Unknown date' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { monthKey: 'unknown', monthLabel: 'Unknown date' }
  return {
    monthKey: d.toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7), // YYYY-MM
    monthLabel: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: tz }),
  }
}

/**
 * Compact "Mon, Apr 20 · 7:14 PM" stamp for a drive-list endpoint — weekday +
 * date + time, tz-safe (same `tz` discipline as fmtWhen). Null for a missing /
 * unparseable timestamp (e.g. an in-progress drive's end).
 */
function stampShort(iso: string | null, tz?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz })
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  const tm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${wd}, ${md} · ${tm}`
}

function relativeAgo(iso: string | null): string | null {
  if (!iso) return null
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 90) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface OverviewVM {
  hasVehicle: boolean
  hasSnapshot: boolean
  vehicleName: string | null
  trim: string | null
  statusLabel: string
  soc: number | null
  rangeKm: number | null
  odoKm: number | null
  effWhKm: number | null
  insideC: number | null
  outsideC: number | null
  /** Four tire pressures (bar) FL/FR/RL/RR; entries may be null; whole thing null if none. */
  tiresBar: (number | null)[] | null
  ready: boolean | null
  readyTitle: string | null
  lastDrive: { title: string; distKm: number; durMin: number; effWhKm: number | null } | null
  syncedLabel: string | null
  /** Last known GPS position [lat, lng], or null if the latest snapshot has no fix. */
  location: [number, number] | null
  locationWhen: string | null
}

export function buildOverview(
  overview: OverviewPayload,
  readiness: DepartureReadinessPayload,
  drives: DrivesPayload,
  activeVin?: string | null,
  tz?: string,
): OverviewVM {
  const vw =
    (activeVin ? overview.vehicles.find((v) => v.vehicle.vin === activeVin) : null) ??
    overview.vehicles[0] ??
    null
  const latest = vw?.latest ?? null
  // readiness/drives are already scoped to the active car by the loader, so the
  // first (only) readiness row is the active vehicle's.
  const r0 = readiness.vehicles.find((r) => r.vin === activeVin) ?? readiness.vehicles[0] ?? null

  const soc = r0?.soc_pct ?? latest?.usable_battery_level ?? latest?.battery_level ?? null
  const rangeMi = r0?.est_range_mi ?? latest?.est_battery_range ?? latest?.battery_range ?? null
  const rangeKm = rangeMi != null ? round(miToKm(rangeMi)) : null
  const odoKm = latest?.odometer != null ? round(miToKm(latest.odometer)) : null
  const effWhKm = drives.stats.avgWhPerMi != null ? round(whPerMiToWhKm(drives.stats.avgWhPerMi)) : null

  const targetSoc = r0?.target_soc ?? 60
  const ready = soc != null ? soc >= targetSoc : null
  const readyTitle = ready == null ? null : ready ? 'Ready for tomorrow' : 'Consider charging tonight'

  const tpms = latest ? [latest.tpms_fl, latest.tpms_fr, latest.tpms_rl, latest.tpms_rr] : null
  const tiresBar = tpms && tpms.some((t) => t != null) ? tpms : null

  const liveDrive = drives.drives[0]
  const lastDrive: OverviewVM['lastDrive'] = liveDrive
    ? {
        title: fmtWhen(liveDrive.started_at, tz),
        distKm: liveDrive.distance_mi != null ? round(miToKm(liveDrive.distance_mi), 1) : 0,
        durMin: liveDrive.duration_s != null ? Math.round(liveDrive.duration_s / 60) : 0,
        effWhKm: liveDrive.wh_per_mi != null ? round(whPerMiToWhKm(liveDrive.wh_per_mi)) : null,
      }
    : null

  return {
    hasVehicle: !!vw,
    hasSnapshot: !!latest,
    vehicleName: vw?.vehicle.display_name ?? null,
    trim: vw?.vehicle.car_type ?? null,
    // Tesla reports shift_state "P" when parked (a truthy string), so only D/R/N
    // mean actually in gear — matches the poller's drive detection.
    statusLabel: r0?.is_charging
      ? 'Charging'
      : latest?.shift_state === 'D' || latest?.shift_state === 'R' || latest?.shift_state === 'N'
        ? 'Driving'
        : 'Parked',
    soc,
    rangeKm,
    odoKm,
    effWhKm,
    insideC: latest?.inside_temp ?? null,
    outsideC: latest?.outside_temp ?? null,
    tiresBar,
    ready,
    readyTitle,
    lastDrive,
    syncedLabel: relativeAgo(r0?.as_of ?? latest?.recorded_at ?? null),
    location:
      latest?.latitude != null && latest?.longitude != null
        ? [latest.latitude, latest.longitude]
        : null,
    locationWhen: relativeAgo(latest?.gps_as_of ?? latest?.recorded_at ?? null),
  }
}

// ── Drives ───────────────────────────────────────────────────────────────────

export interface DriveVM {
  id: string
  driveId: number
  title: string
  when: string
  /** Month bucket for grouping/filtering: machine key (YYYY-MM) + display label. */
  monthKey: string
  monthLabel: string
  distKm: number
  durMin: number
  avgKph: number
  kwh: number | null
  /** Drive consumption in Wh/km (canonical); null when not computed. */
  effWhKm: number | null
  /** Resolved start/end place names (geofence/address), null until reverse-geocoded. */
  startPlace: string | null
  endPlace: string | null
  /** State of charge (%) at each endpoint. */
  startBattery: number | null
  endBattery: number | null
  /** "Mon, Apr 20 · 7:14 PM" for each endpoint; endStamp null while in progress. */
  startStamp: string | null
  endStamp: string | null
  /** Start/end coords the drive row carries (immediate line before the breadcrumb loads). */
  endpoints: [number, number][]
}

export function buildDrives(payload: DrivesPayload, tz?: string): DriveVM[] {
  return payload.drives.map((d) => {
    const distKm = d.distance_mi != null ? miToKm(d.distance_mi) : 0
    const durMin = d.duration_s != null ? Math.round(d.duration_s / 60) : 0
    const hours = d.duration_s != null && d.duration_s > 0 ? d.duration_s / 3600 : 0
    const avgKph = hours > 0 && d.distance_mi != null ? round(miToKm(d.distance_mi) / hours) : 0
    const endpoints: [number, number][] = []
    if (d.start_lat != null && d.start_lng != null) endpoints.push([d.start_lat, d.start_lng])
    if (d.end_lat != null && d.end_lng != null) endpoints.push([d.end_lat, d.end_lng])
    // Prefer a place label ("A → B") as the title; fall back to the timestamp when
    // no address/geofence is known (e.g. live drives before reverse-geocode backfill).
    const s = d.startLocation
    const e = d.endLocation
    const place = s && e ? (s === e ? s : `${s} → ${e}`) : e || s || null
    return {
      id: String(d.id),
      driveId: d.id,
      ...monthParts(d.started_at, tz),
      title: place ?? fmtWhen(d.started_at, tz),
      when: place
        ? fmtWhen(d.started_at, tz)
        : d.start_battery_level != null && d.end_battery_level != null
          ? `${d.start_battery_level}% → ${d.end_battery_level}%`
          : new Date(d.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz }),
      distKm: round(distKm, 1),
      durMin,
      avgKph,
      kwh: d.energy_used_kwh != null ? round(d.energy_used_kwh, 1) : null,
      effWhKm: d.wh_per_mi != null && d.wh_per_mi > 0 ? round(whPerMiToWhKm(d.wh_per_mi)) : null,
      startPlace: s,
      endPlace: e,
      startBattery: d.start_battery_level,
      endBattery: d.end_battery_level,
      startStamp: stampShort(d.started_at, tz),
      endStamp: stampShort(d.ended_at, tz),
      endpoints,
    }
  })
}

// ── Charging ─────────────────────────────────────────────────────────────────

export interface SessionVM {
  id: string
  sessionId: number
  loc: string
  when: string
  /** Month bucket for grouping/filtering: machine key (YYYY-MM) + display label. */
  monthKey: string
  monthLabel: string
  type: string
  isFast: boolean
  addedKwh: number | null
  durMin: number
  cost: number | null
  currency: string
  /** Provenance of `cost`: computed | tesla_billed | tesla_billed_free | geofence | imported_teslamate | manual. */
  costSource: string
}

export function buildSessions(payload: ChargingPayload, tz?: string): SessionVM[] {
  return payload.sessions.map((s) => {
    const isFast = s.source === 'supercharger'
    const durMin =
      s.ended_at != null
        ? Math.max(1, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000))
        : 0
    return {
      id: String(s.id),
      sessionId: s.id,
      ...monthParts(s.started_at, tz),
      loc: s.locationName ?? s.location_name ?? (isFast ? 'Supercharger' : 'Charge session'),
      when: fmtWhen(s.started_at, tz),
      type: isFast ? 'DC fast' : 'AC',
      isFast,
      addedKwh: s.energy_added_kwh != null ? round(s.energy_added_kwh, 1) : null,
      durMin,
      cost: s.cost_amount ?? null,
      currency: s.cost_currency ?? 'USD',
      costSource: s.cost_source ?? 'computed',
    }
  })
}

// ── Insights ─────────────────────────────────────────────────────────────────

export interface InsightsVM {
  hasCharge: boolean
  hasDrives: boolean
  costPerMonth: number | null
  costPerMi: number | null
  lifetimeSpend: number | null
  currency: string
  homePct: number | null
  daysDriven: number | null
  longestKm: number | null
  mostEffWhKm: number | null
  odoKm: number | null
  lifetimeDistKm: number | null
  phantom: { lostKm: number; perDayKm: number; days: number; series: { date: string; lostKm: number }[] } | null
}

export function buildInsights(
  charging: ChargingPayload,
  drives: DrivesPayload,
  overviewKmOdo: number | null,
  phantom: PhantomDrain,
): InsightsVM {
  const st = charging.stats
  const hasCharge = st.sessionCount > 0
  const hasDrives = drives.drives.length > 0

  const totalSplit = st.superchargerCost + st.homeCost
  const effWhPerMi = drives.drives.map((d) => d.wh_per_mi).filter((w): w is number => w != null && w > 0)

  return {
    hasCharge,
    hasDrives,
    costPerMonth: hasCharge ? estimateMonthly(charging) : null,
    costPerMi: st.avgCostPerMile,
    lifetimeSpend: hasCharge ? round(st.totalCost) : null,
    currency: st.currency ?? 'USD',
    homePct: hasCharge && totalSplit > 0 ? st.homeCost / totalSplit : null,
    daysDriven: hasDrives ? distinctDays(drives) : null,
    longestKm: hasDrives ? round(miToKm(Math.max(...drives.drives.map((d) => d.distance_mi ?? 0)))) : null,
    mostEffWhKm: effWhPerMi.length > 0 ? round(whPerMiToWhKm(Math.min(...effWhPerMi))) : null,
    odoKm: overviewKmOdo,
    lifetimeDistKm: hasDrives ? round(miToKm(drives.stats.totalMiles)) : null,
    phantom: phantom.hasData
      ? {
          lostKm: round(miToKm(phantom.lostMi), 1),
          perDayKm: round(miToKm(phantom.perDayMi), 1),
          days: phantom.days,
          series: phantom.series.map((d) => ({ date: d.date, lostKm: round(miToKm(d.lostMi), 1) })),
        }
      : null,
  }
}

function estimateMonthly(charging: ChargingPayload): number {
  const ts = charging.sessions.map((s) => new Date(s.started_at).getTime()).filter((n) => !Number.isNaN(n))
  if (ts.length < 2) return round(charging.stats.totalCost)
  const spanDays = Math.max(1, (Math.max(...ts) - Math.min(...ts)) / 86_400_000)
  return round((charging.stats.totalCost / spanDays) * 30)
}

function distinctDays(drives: DrivesPayload): number {
  const days = new Set(drives.drives.map((d) => new Date(d.started_at).toDateString()))
  return days.size
}

// ── Charging year-in-review ────────────────────────────────────────────────────

export interface ReviewLocation {
  name: string
  sessions: number
  energyKwh: number
}
export interface ChargingReviewVM {
  hasData: boolean
  /** Window label, e.g. "Last 12 months". */
  periodLabel: string
  sessions: number
  energyKwh: number
  cost: number
  currency: string
  /** Share of energy added at home/AC (0–1), null when no cost/energy split. */
  homeEnergyPct: number | null
  topLocations: ReviewLocation[]
  /** "Mon YYYY" of the month with the most sessions, or null. */
  busiestMonth: string | null
}

/**
 * A "wrapped"-style charging summary over the trailing 12 months, derived purely
 * from the already-loaded charging payload (no extra query). Totals, the home/SC
 * energy split, the top charging places, and the busiest month. The 12-month
 * window is anchored on the most recent session (not the wall clock) so the SSR
 * and client renders agree — see the hydration note at the top of this module.
 */
export function buildChargingReview(charging: ChargingPayload, tz?: string): ChargingReviewVM {
  const times = charging.sessions
    .map((s) => new Date(s.started_at).getTime())
    .filter((t) => !Number.isNaN(t))
  const anchor = times.length ? Math.max(...times) : 0
  const since = anchor - 365 * 86_400_000
  const inWindow = charging.sessions.filter((s) => {
    const t = new Date(s.started_at).getTime()
    return !Number.isNaN(t) && t >= since
  })

  const base: ChargingReviewVM = {
    hasData: false,
    periodLabel: 'Last 12 months',
    sessions: 0,
    energyKwh: 0,
    cost: 0,
    currency: charging.stats.currency ?? 'USD',
    homeEnergyPct: null,
    topLocations: [],
    busiestMonth: null,
  }
  if (inWindow.length === 0) return base

  let energyKwh = 0
  let homeEnergy = 0
  let totalEnergyForSplit = 0
  let cost = 0
  let currency = base.currency
  const byLoc = new Map<string, { sessions: number; energyKwh: number }>()
  const byMonth = new Map<string, number>()

  for (const s of inWindow) {
    const e = s.energy_added_kwh ?? 0
    energyKwh += e
    cost += s.cost_amount ?? 0
    if (s.cost_currency) currency = s.cost_currency
    if (e > 0) {
      totalEnergyForSplit += e
      if (s.source !== 'supercharger') homeEnergy += e
    }
    const name = s.locationName ?? s.location_name ?? (s.source === 'supercharger' ? 'Supercharger' : 'Charge session')
    const loc = byLoc.get(name) ?? { sessions: 0, energyKwh: 0 }
    loc.sessions += 1
    loc.energyKwh += e
    byLoc.set(name, loc)
    const mk = monthLabel(s.started_at, tz)
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + 1)
  }

  const topLocations = [...byLoc.entries()]
    .map(([name, v]) => ({ name, sessions: v.sessions, energyKwh: round(v.energyKwh, 1) }))
    .sort((a, b) => b.sessions - a.sessions || b.energyKwh - a.energyKwh)
    .slice(0, 3)
  const busiestMonth =
    [...byMonth.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0]?.[0] ?? null

  return {
    hasData: true,
    periodLabel: 'Last 12 months',
    sessions: inWindow.length,
    energyKwh: round(energyKwh, 1),
    cost: round(cost),
    currency,
    homeEnergyPct: totalEnergyForSplit > 0 ? homeEnergy / totalEnergyForSplit : null,
    topLocations,
    busiestMonth,
  }
}

/** "Mon YYYY" label for a timestamp in zone `tz` (UTC during SSR). */
function monthLabel(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: tz })
}
