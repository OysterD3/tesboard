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

function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  const isYest = d.toDateString() === yest.toDateString()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today · ${time}`
  if (isYest) return `Yesterday · ${time}`
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${date} · ${time}`
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
}

export function buildOverview(
  overview: OverviewPayload,
  readiness: DepartureReadinessPayload,
  drives: DrivesPayload,
  activeVin?: string | null,
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
        title: fmtWhen(liveDrive.started_at),
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
    statusLabel: r0?.is_charging ? 'Charging' : latest?.shift_state ? 'Driving' : 'Parked',
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
  }
}

// ── Drives ───────────────────────────────────────────────────────────────────

export interface DriveVM {
  id: string
  driveId: number
  title: string
  when: string
  distKm: number
  durMin: number
  avgKph: number
  kwh: number | null
  /** Start/end coords the drive row carries (immediate line before the breadcrumb loads). */
  endpoints: [number, number][]
}

export function buildDrives(payload: DrivesPayload): DriveVM[] {
  return payload.drives.map((d) => {
    const distKm = d.distance_mi != null ? miToKm(d.distance_mi) : 0
    const durMin = d.duration_s != null ? Math.round(d.duration_s / 60) : 0
    const hours = d.duration_s != null && d.duration_s > 0 ? d.duration_s / 3600 : 0
    const avgKph = hours > 0 && d.distance_mi != null ? round(miToKm(d.distance_mi) / hours) : 0
    const endpoints: [number, number][] = []
    if (d.start_lat != null && d.start_lng != null) endpoints.push([d.start_lat, d.start_lng])
    if (d.end_lat != null && d.end_lng != null) endpoints.push([d.end_lat, d.end_lng])
    return {
      id: String(d.id),
      driveId: d.id,
      title: fmtWhen(d.started_at),
      when:
        d.start_battery_level != null && d.end_battery_level != null
          ? `${d.start_battery_level}% → ${d.end_battery_level}%`
          : new Date(d.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      distKm: round(distKm, 1),
      durMin,
      avgKph,
      kwh: d.energy_used_kwh != null ? round(d.energy_used_kwh, 1) : null,
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
  type: string
  isFast: boolean
  addedKwh: number | null
  durMin: number
  cost: number | null
  currency: string
}

export function buildSessions(payload: ChargingPayload): SessionVM[] {
  return payload.sessions.map((s) => {
    const isFast = s.source === 'supercharger'
    const durMin =
      s.ended_at != null
        ? Math.max(1, Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000))
        : 0
    return {
      id: String(s.id),
      sessionId: s.id,
      loc: s.location_name ?? (isFast ? 'Supercharger' : 'Charge session'),
      when: fmtWhen(s.started_at),
      type: isFast ? 'DC fast' : 'AC',
      isFast,
      addedKwh: s.energy_added_kwh != null ? round(s.energy_added_kwh, 1) : null,
      durMin,
      cost: s.cost_amount ?? null,
      currency: s.cost_currency ?? 'USD',
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
  phantom: { lostKm: number; perDayKm: number; days: number } | null
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
      ? { lostKm: round(miToKm(phantom.lostMi), 1), perDayKm: round(miToKm(phantom.perDayMi), 1), days: phantom.days }
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
