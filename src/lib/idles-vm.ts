/**
 * Pure view-models for the Idles feature. An "idle" is the parked gap between two
 * consecutive drives — there is no idle table, so both the history list/map and
 * the detail page are derived:
 *
 *  - `buildIdles` turns the already-loaded drive rows (newest-first) into a list
 *    of parked windows (gap between one drive's end and the next drive's start),
 *    entirely client-side. Used by the history list and the park-pin map.
 *  - `buildIdleDetail` turns the server payload (snapshots + state spans + charge
 *    overlap for one window) into display-ready stats and chart series.
 *
 * Canonical units throughout (distance km, temp °C, energy kWh); the route applies
 * the user's unit selection at the formatter boundary. No React / no server
 * imports — unit-testable (see idles-vm.test.ts).
 */
import type { DriveWithLocation } from '../functions/drives.functions'
import type { IdleDetailPayload, IdleStateSpan } from '../functions/idle-detail.functions'

const KM_PER_MI = 1.60934
const miToKm = (mi: number) => mi * KM_PER_MI

function round(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

/**
 * Gaps shorter than this (seconds) are poller jitter (a drive split into two
 * segments), not a real park. Shared by the list builder and getIdleDetail so the
 * two derivations agree on what counts as an idle.
 */
export const IDLE_MIN_GAP_S = 60

export interface Pt {
  /** Elapsed minutes from the start of the parked window. */
  x: number
  y: number
}

// ── shared date helpers (tz-safe, same discipline as dashboard-vm.ts) ──────────

function monthParts(iso: string | null, tz?: string): { monthKey: string; monthLabel: string } {
  if (!iso) return { monthKey: 'unknown', monthLabel: 'Unknown date' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { monthKey: 'unknown', monthLabel: 'Unknown date' }
  return {
    monthKey: d.toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7), // YYYY-MM
    monthLabel: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: tz }),
  }
}

/** "Mon, Apr 20 · 7:14 PM" — weekday + date + time for an endpoint (tz-safe). */
function stampShort(iso: string | null, tz?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: tz })
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
  const tm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${wd}, ${md} · ${tm}`
}

function dayLabel(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })
}
function clock(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
}

/** "1h 4m" / "47m" — tz-independent elapsed-duration label. */
export function fmtIdleDuration(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

// ── energy ─────────────────────────────────────────────────────────────────

/**
 * Battery energy drained while parked + the rated range it represents. Prefer the
 * rated-range drop × efficiency (fine-grained, matches the drive energy model);
 * fall back to the (coarse, integer) SOC drop × pack size. Only positive drops
 * count as "used"; a window where the car charged reads ~0 here (charger energy
 * is tracked separately).
 */
function idleEnergy(
  startRangeMi: number | null,
  endRangeMi: number | null,
  startBatt: number | null,
  endBatt: number | null,
  effWhPerMi: number | null,
  packKwh: number | null,
): { batteryKwh: number | null; rangeUsedKm: number | null } {
  const rangeDropMi = startRangeMi != null && endRangeMi != null ? startRangeMi - endRangeMi : null
  const rangeUsedKm = rangeDropMi != null && rangeDropMi > 0 ? round(miToKm(rangeDropMi), 2) : null
  let batteryKwh: number | null = null
  // Prefer the fine-grained rated-range signal whenever it can answer (both range
  // endpoints AND an efficiency present). A present-but-flat/negative range reads as
  // no drain (null) — we do NOT fall back to the coarse integer SOC drop in that
  // case, or a spurious 1% SOC step would manufacture drain the range denied. Only
  // fall back to SOC × pack when range genuinely can't answer (missing range/eff).
  if (rangeDropMi != null && effWhPerMi != null && effWhPerMi > 0) {
    batteryKwh = rangeDropMi > 0 ? round((rangeDropMi * effWhPerMi) / 1000, 2) : null
  } else {
    const socDrop = startBatt != null && endBatt != null ? startBatt - endBatt : null
    if (socDrop != null && socDrop > 0 && packKwh != null && packKwh > 0) {
      batteryKwh = round((socDrop / 100) * packKwh, 2)
    }
  }
  return { batteryKwh, rangeUsedKm }
}

// ── history list / map ───────────────────────────────────────────────────────

export interface IdleVM {
  /** String form of `prevDriveId` (the list/route key). */
  id: string
  /** The preceding drive whose end opens this parked window. */
  prevDriveId: number
  /** Place name, else a date fallback. */
  title: string
  place: string | null
  /** "Mon, Apr 20 · 6:26 PM" for each endpoint (tz-safe). */
  startStamp: string | null
  endStamp: string | null
  /** SOC at the park endpoints. */
  startBattery: number | null
  endBattery: number | null
  durMin: number
  /** Estimated battery energy drained while parked (kWh); null when not derivable. */
  batteryKwh: number | null
  /** Rated range used while parked (km); null when not derivable. */
  rangeUsedKm: number | null
  /** Park coordinates (the preceding drive's end). */
  lat: number | null
  lng: number | null
  monthKey: string
  monthLabel: string
}

export interface BuildIdlesOpts {
  tz?: string
  /** Active vehicle efficiency (Wh/rated-mi) for the energy estimate. */
  effWhPerMi?: number | null
  /** Active vehicle usable pack (kWh) — fallback energy estimate. */
  packKwh?: number | null
  /** Drop gaps shorter than this (s) as poller jitter, not real idles. */
  minGapSec?: number
}

/**
 * Derive parked windows from the drive list (newest-first, closed drives only).
 * Each idle is the gap between drive `i+1`'s end (the earlier drive) and drive
 * `i`'s start (the later drive). Skips zero/negative gaps, sub-`minGapSec` jitter,
 * and pairs that aren't the same car.
 */
export function buildIdles(drives: DriveWithLocation[], opts: BuildIdlesOpts = {}): IdleVM[] {
  const { tz, effWhPerMi = null, packKwh = null, minGapSec = IDLE_MIN_GAP_S } = opts
  const out: IdleVM[] = []
  for (let i = 0; i < drives.length; i++) {
    const next = drives[i] // later drive — its start ends the idle
    // Nearest earlier drive for the SAME car opens the idle. In the normal
    // single-car dashboard that's just drives[i + 1]; scanning back keeps the
    // pairing correct in a multi-car, time-interleaved list (car A's park can
    // straddle a car B drive) instead of dropping it.
    let prev: DriveWithLocation | undefined
    for (let j = i + 1; j < drives.length; j++) {
      if (drives[j].vin === next.vin) {
        prev = drives[j]
        break
      }
    }
    if (!prev || !prev.ended_at) continue
    const startMs = new Date(prev.ended_at).getTime()
    const endMs = new Date(next.started_at).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    const gapSec = (endMs - startMs) / 1000
    if (gapSec < minGapSec) continue
    const { batteryKwh, rangeUsedKm } = idleEnergy(
      prev.end_range_mi,
      next.start_range_mi,
      prev.end_battery_level,
      next.start_battery_level,
      effWhPerMi,
      packKwh,
    )
    const place = prev.endLocation ?? null
    const { monthKey, monthLabel } = monthParts(prev.ended_at, tz)
    out.push({
      id: String(prev.id),
      prevDriveId: prev.id,
      title: place ?? `${dayLabel(prev.ended_at, tz)} · ${clock(prev.ended_at, tz)}`,
      place,
      startStamp: stampShort(prev.ended_at, tz),
      endStamp: stampShort(next.started_at, tz),
      startBattery: prev.end_battery_level,
      endBattery: next.start_battery_level,
      durMin: Math.round(gapSec / 60),
      batteryKwh,
      rangeUsedKm,
      lat: prev.end_lat,
      lng: prev.end_lng,
      monthKey,
      monthLabel,
    })
  }
  return out
}

// ── detail page ──────────────────────────────────────────────────────────────

export interface IdleDetailSeries {
  /** Battery state-of-charge (%) over time. */
  soc: Pt[]
  /** Rated range (km, canonical) over time. */
  rangeKm: Pt[]
  /** Cabin (interior) temperature (°C) over time. */
  insideC: Pt[]
  /** Outside (exterior) temperature (°C) over time. */
  outsideC: Pt[]
  /** Charger power (kW) over time — flat at 0 unless a charge ran during the park. */
  powerKw: Pt[]
}

export interface IdleDetailVM {
  found: boolean
  title: string
  /** Date + time range, e.g. "Apr 20 · 6:26 – 7:14 PM". */
  subtitle: string
  place: string | null
  startStamp: string
  endStamp: string | null
  durMin: number
  batteryStart: number | null
  batteryEnd: number | null
  /** end − start SOC (negative = drained, positive = charged). */
  socDelta: number | null
  /** Battery energy drained while parked (kWh). */
  batteryKwh: number | null
  /** Grid energy added by overlapping charges (kWh). */
  chargerKwh: number | null
  /** Rated range used while parked (km). */
  rangeUsedKm: number | null
  /** Share of the window asleep / online / offline (%); null when unknown. */
  asleepPct: number | null
  onlinePct: number | null
  offlinePct: number | null
  cost: { amount: number; currency: string } | null
  hasMap: boolean
  series: IdleDetailSeries
}

const EMPTY_SERIES: IdleDetailSeries = { soc: [], rangeKm: [], insideC: [], outsideC: [], powerKw: [] }

const EMPTY_DETAIL: IdleDetailVM = {
  found: false,
  title: 'Idle',
  subtitle: '',
  place: null,
  startStamp: '',
  endStamp: null,
  durMin: 0,
  batteryStart: null,
  batteryEnd: null,
  socDelta: null,
  batteryKwh: null,
  chargerKwh: null,
  rangeUsedKm: null,
  asleepPct: null,
  onlinePct: null,
  offlinePct: null,
  cost: null,
  hasMap: false,
  series: EMPTY_SERIES,
}

/** Sum each state's overlap with [startMs, endMs] and express as a % of the window. */
function stateSplit(
  states: IdleStateSpan[],
  startMs: number,
  endMs: number,
): { asleepPct: number | null; onlinePct: number | null; offlinePct: number | null } {
  const winSec = Math.max(0, (endMs - startMs) / 1000)
  if (winSec <= 0 || states.length === 0) return { asleepPct: null, onlinePct: null, offlinePct: null }
  const totals = new Map<string, number>()
  for (const s of states) {
    const sMs = new Date(s.started_at).getTime()
    const eMs = s.ended_at ? new Date(s.ended_at).getTime() : endMs
    const a = Math.max(sMs, startMs)
    const b = Math.min(eMs, endMs)
    const secs = Math.max(0, (b - a) / 1000)
    if (secs > 0) totals.set(s.state, (totals.get(s.state) ?? 0) + secs)
  }
  const pct = (k: string) => round(((totals.get(k) ?? 0) / winSec) * 100)
  return { asleepPct: pct('asleep'), onlinePct: pct('online'), offlinePct: pct('offline') }
}

export function buildIdleDetail(p: IdleDetailPayload, tz?: string): IdleDetailVM {
  if (!p.found || !p.startedAt || !p.endedAt) return EMPTY_DETAIL

  const startMs = new Date(p.startedAt).getTime()
  const endMs = new Date(p.endedAt).getTime()
  const durMin = Math.max(0, Math.round((endMs - startMs) / 60000))

  const series: IdleDetailSeries = {
    soc: p.samples.filter((s) => s.soc != null).map((s) => ({ x: s.tMin, y: s.soc as number })),
    rangeKm: p.samples
      .filter((s) => s.rangeMi != null)
      .map((s) => ({ x: s.tMin, y: round(miToKm(s.rangeMi as number), 1) })),
    insideC: p.samples.filter((s) => s.insideC != null).map((s) => ({ x: s.tMin, y: s.insideC as number })),
    outsideC: p.samples.filter((s) => s.outsideC != null).map((s) => ({ x: s.tMin, y: s.outsideC as number })),
    powerKw: p.samples.filter((s) => s.powerKw != null).map((s) => ({ x: s.tMin, y: round(s.powerKw as number, 1) })),
  }

  const { batteryKwh, rangeUsedKm } = idleEnergy(
    p.startRangeMi,
    p.endRangeMi,
    p.startBattery,
    p.endBattery,
    p.effWhPerMi,
    p.packKwh,
  )
  const { asleepPct, onlinePct, offlinePct } = stateSplit(p.states, startMs, endMs)

  const sDay = dayLabel(p.startedAt, tz)
  const sClock = clock(p.startedAt, tz)
  const eDay = dayLabel(p.endedAt, tz)
  const eClock = clock(p.endedAt, tz)
  const subtitle =
    sDay === eDay ? `${sDay} · ${sClock} – ${eClock}` : `${sDay} ${sClock} – ${eDay} ${eClock}`

  return {
    found: true,
    title: p.place ?? `${sDay} · ${sClock}`,
    subtitle,
    place: p.place,
    startStamp: stampShort(p.startedAt, tz) ?? '',
    endStamp: stampShort(p.endedAt, tz),
    durMin,
    batteryStart: p.startBattery,
    batteryEnd: p.endBattery,
    socDelta: p.startBattery != null && p.endBattery != null ? p.endBattery - p.startBattery : null,
    batteryKwh,
    chargerKwh: p.chargerKwh != null ? round(p.chargerKwh, 2) : null,
    rangeUsedKm,
    asleepPct,
    onlinePct,
    offlinePct,
    cost: p.cost ? { amount: round(p.cost.amount, 2), currency: p.cost.currency } : null,
    hasMap: p.point != null,
    series,
  }
}
