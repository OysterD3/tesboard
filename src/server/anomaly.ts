/**
 * Anomaly detection helpers (notify-only). Run inside the poller at session/drive
 * CLOSE, where the closing row's derived stats are in hand and the comparison
 * baselines are cheap to read. Each detector returns an AnomalyCandidate or null;
 * the poller inserts the candidate into `anomaly_flag` best-effort (a partial
 * unique index makes re-runs idempotent). Every read here is user_id-scoped —
 * RLS is enabled-with-no-policy, so the predicate is the only tenant isolation.
 */
import { and, desc, eq, gt, gte, isNotNull, lt, lte, ne } from 'drizzle-orm'
import type { Db } from './db'
import { driveSession, vehicleSnapshot } from './schema'
import type { AnomalySeverity, AnomalyType, Json } from '../types/db'

// Slow-charge: a closed home/known-location charge whose avg power is materially
// below what that location usually delivers.
export const SLOW_CHARGE_RATIO = 0.7 // flag if avg kW <= 70% of the location baseline
export const MIN_CHARGE_KWH = 3 // ignore short top-ups (noisy)
export const MIN_SLOW_SAMPLES = 10 // baseline needs enough historical power readings
export const NEAR_FULL_SOC = 95 // exclude tapering near full (legitimately slow)
const CELL_DELTA_DEG = 0.002 // ~200m bounding box around the session coords
const BASELINE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000 // 60 days of history

// Efficiency-drop: a drive whose Wh/mi is materially worse than the recent median.
export const EFFICIENCY_DROP_RATIO = 1.25 // flag if >= 125% of the trailing median
export const MIN_DRIVE_MI = 5 // avoid quantization noise on short hops
export const MIN_BASELINE_DRIVES = 5
const BASELINE_DRIVES = 20

export interface AnomalyCandidate {
  type: AnomalyType
  severity: AnomalySeverity
  message: string
  observed: number | null
  baseline: number | null
  detail: Json
}

/** Rounded ~110m grid key for a coordinate (display / dedup only). */
export function locationCell(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

/**
 * Compare this charge's average power against the typical charging power observed
 * at the same location (a small lat/lng box) over the trailing window.
 */
export async function detectSlowCharge(params: {
  db: Db
  userId: string
  vin: string
  chargeId: number
  startedAt: string
  lat: number | null
  lng: number | null
  avgKw: number | null
  energyKwh: number
  endBatteryLevel: number | null
}): Promise<AnomalyCandidate | null> {
  const { db, userId, vin, startedAt, lat, lng, avgKw, energyKwh, endBatteryLevel } = params
  if (lat == null || lng == null) return null
  if (avgKw == null || avgKw <= 0) return null
  if (energyKwh < MIN_CHARGE_KWH) return null
  if (endBatteryLevel != null && endBatteryLevel >= NEAR_FULL_SOC) return null // tapering, not a fault

  const cutoff = new Date(new Date(startedAt).getTime() - BASELINE_WINDOW_MS).toISOString()
  const rows = await db
    .select({ p: vehicleSnapshot.charger_power })
    .from(vehicleSnapshot)
    .where(
      and(
        eq(vehicleSnapshot.user_id, userId),
        eq(vehicleSnapshot.vin, vin),
        gte(vehicleSnapshot.latitude, lat - CELL_DELTA_DEG),
        lte(vehicleSnapshot.latitude, lat + CELL_DELTA_DEG),
        gte(vehicleSnapshot.longitude, lng - CELL_DELTA_DEG),
        lte(vehicleSnapshot.longitude, lng + CELL_DELTA_DEG),
        gt(vehicleSnapshot.charger_power, 0),
        gte(vehicleSnapshot.recorded_at, cutoff),
        lt(vehicleSnapshot.recorded_at, startedAt), // exclude the current session
      ),
    )
  const powers = rows.map((r) => r.p).filter((n): n is number => n != null && n > 0)
  if (powers.length < MIN_SLOW_SAMPLES) return null

  const baseline = powers.reduce((a, b) => a + b, 0) / powers.length
  if (baseline <= 0 || avgKw > SLOW_CHARGE_RATIO * baseline) return null

  const pctSlower = Math.round((1 - avgKw / baseline) * 100)
  return {
    type: 'slow_charge',
    severity: pctSlower >= 40 ? 'warning' : 'info',
    message: `Charged at ${round(avgKw)} kW here — usually about ${round(baseline)} kW (${pctSlower}% slower).`,
    observed: round(avgKw, 2),
    baseline: round(baseline, 2),
    detail: { location_cell: locationCell(lat, lng), samples: powers.length, pct_slower: pctSlower },
  }
}

/**
 * Compare this drive's Wh/mi against the trailing median of recent qualifying
 * drives for the same vehicle. Median resists one-off hard-acceleration drives.
 */
export async function detectEfficiencyDrop(params: {
  db: Db
  userId: string
  vin: string
  driveId: number
  whPerMi: number | null
  distanceMi: number | null
}): Promise<AnomalyCandidate | null> {
  const { db, userId, vin, driveId, whPerMi, distanceMi } = params
  if (whPerMi == null || whPerMi <= 0) return null
  if (distanceMi == null || distanceMi < MIN_DRIVE_MI) return null

  const rows = await db
    .select({ w: driveSession.wh_per_mi })
    .from(driveSession)
    .where(
      and(
        eq(driveSession.user_id, userId),
        eq(driveSession.vin, vin),
        ne(driveSession.id, driveId),
        isNotNull(driveSession.wh_per_mi),
        gte(driveSession.distance_mi, MIN_DRIVE_MI),
      ),
    )
    .orderBy(desc(driveSession.started_at))
    .limit(BASELINE_DRIVES)
  const vals = rows.map((r) => r.w).filter((n): n is number => n != null && n > 0)
  if (vals.length < MIN_BASELINE_DRIVES) return null

  const baseline = median(vals)
  if (baseline <= 0 || whPerMi < EFFICIENCY_DROP_RATIO * baseline) return null

  const pctWorse = Math.round((whPerMi / baseline - 1) * 100)
  return {
    type: 'efficiency_drop',
    severity: pctWorse >= 50 ? 'warning' : 'info',
    message: `This drive used ${Math.round(whPerMi)} Wh/mi — about ${pctWorse}% above your usual ${Math.round(baseline)} Wh/mi.`,
    observed: round(whPerMi, 2),
    baseline: round(baseline, 2),
    detail: { samples: vals.length, pct_worse: pctWorse },
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
