/**
 * Per-vehicle efficiency factor (Wh per rated mile), TeslaMate's modal-bucket
 * approach adapted to tesboard's miles. This is the constant that converts a
 * rated-range delta into energy — it powers accurate drive energy AND battery
 * degradation. Replaces the old global PACK_KWH=75 guess.
 *
 * Method: for each "clean" charge (long enough, not topped past 95%, real range
 * gained), factor = energy_added_kWh / rated_miles_added. Bucket the factors at
 * progressively coarser precision and take the modal value once a bucket has
 * enough support; fall back to the median. The mode is robust to the odd session
 * where range/energy bookkeeping is noisy.
 */
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { Db } from './db'
import { chargeSession, vehicle } from './schema'

export interface EffSample {
  energyKwh: number
  rangeAddedMi: number
}

const RETRY: Array<[precision: number, minCount: number]> = [
  [3, 8],
  [3, 5],
  [2, 5],
  [2, 3],
  [1, 3],
  [1, 2],
]

/** Derive Wh/mi from clean charge samples (mode, then median). Null if no signal. */
export function deriveEfficiencyWhPerMi(samples: EffSample[]): number | null {
  const factors = samples
    .filter((s) => s.rangeAddedMi > 0 && s.energyKwh > 0)
    .map((s) => s.energyKwh / s.rangeAddedMi) // kWh per mile
  if (!factors.length) return null

  for (const [precision, minCount] of RETRY) {
    const counts = new Map<string, number>()
    for (const f of factors) {
      const key = f.toFixed(precision)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let bestKey: string | null = null
    let best = 0
    for (const [k, c] of counts) {
      if (c > best) {
        best = c
        bestKey = k
      }
    }
    if (bestKey != null && best >= minCount) return Number(bestKey) * 1000
  }

  const sorted = [...factors].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return median * 1000
}

/**
 * Recompute and persist vehicle.efficiency_wh_per_mi from this vehicle's charge
 * history. Best-effort; returns the new value (or null if not enough data).
 */
export async function recalculateEfficiency(
  db: Db,
  userId: string,
  vin: string,
): Promise<number | null> {
  const rows = await db
    .select({
      energy: chargeSession.energy_added_kwh,
      startRange: chargeSession.start_range_mi,
      endRange: chargeSession.end_range_mi,
      milesAdded: chargeSession.miles_added_rated,
      startBl: chargeSession.start_battery_level,
      endBl: chargeSession.end_battery_level,
    })
    .from(chargeSession)
    .where(
      and(
        eq(chargeSession.user_id, userId),
        eq(chargeSession.vin, vin),
        isNotNull(chargeSession.ended_at),
        gt(chargeSession.energy_added_kwh, 0),
        // Skip charges that topped out past ~95% (charge tapers distort the factor).
        sql`(${chargeSession.end_battery_level} is null or ${chargeSession.end_battery_level} <= 95)`,
      ),
    )

  const samples: EffSample[] = []
  for (const r of rows) {
    const rangeAdded =
      r.startRange != null && r.endRange != null ? r.endRange - r.startRange : r.milesAdded
    if (r.energy != null && rangeAdded != null && rangeAdded > 0) {
      samples.push({ energyKwh: r.energy, rangeAddedMi: rangeAdded })
    }
  }
  const eff = deriveEfficiencyWhPerMi(samples)
  if (eff == null) return null
  await db
    .update(vehicle)
    .set({ efficiency_wh_per_mi: Math.round(eff * 100) / 100, updated_at: new Date().toISOString() })
    .where(and(eq(vehicle.vin, vin), eq(vehicle.user_id, userId)))
  return eff
}
