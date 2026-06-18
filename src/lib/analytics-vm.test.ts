import { describe, expect, it } from 'vitest'
import {
  binConsumptionByTemp,
  bucketMileage,
  buildBatteryHealth,
  buildBatteryReadings,
  buildPhantomCauses,
  buildPhantomDrain,
  capacityKwh,
  integrateGridEnergyKwh,
  linearRegression,
  maxRangeMiAtFull,
  measuredLossPct,
  odometerForTime,
  recentMean,
  sumChargeEnergyAdded,
  mergeTimeline,
  periodKey,
  projectedRangeMi,
  type OdoSample,
  type PhantomCauseSnap,
  type PhantomSnap,
} from './analytics-vm'

describe('capacityKwh', () => {
  it('back-computes full-pack kWh from range + soc + efficiency', () => {
    // 150 mi rated at 50% with 250 Wh/mi → 150*250/1000=37.5 kWh at 50% → 75 kWh full.
    expect(capacityKwh(150, 50, 250)).toBeCloseTo(75, 6)
  })
  it('guards missing/zero inputs', () => {
    expect(capacityKwh(null, 50, 250)).toBeNull()
    expect(capacityKwh(150, 0, 250)).toBeNull()
  })
})

describe('buildBatteryHealth', () => {
  it('computes current (recent mean), max, and degradation %', () => {
    const h = buildBatteryHealth(
      [
        { date: '2024-01-01', capacityKwh: 80 },
        { date: '2024-06-01', capacityKwh: 78 },
        { date: '2025-01-01', capacityKwh: 76 },
      ],
      2,
    )
    expect(h.maxKwh).toBe(80)
    expect(h.currentKwh).toBeCloseTo(77, 6) // mean of last 2 (78, 76)
    expect(h.degradationPct).toBeCloseTo(100 - (77 * 100) / 80, 6)
  })
  it('handles empty input', () => {
    expect(buildBatteryHealth([]).degradationPct).toBeNull()
  })
})

describe('projectedRangeMi', () => {
  it('projects rated range at 100% from capacity + efficiency', () => {
    expect(projectedRangeMi(75, 250)).toBeCloseTo(300, 6)
  })
})

describe('maxRangeMiAtFull', () => {
  it('extrapolates a rated-range reading to 100% SOC (efficiency-free)', () => {
    // 150 mi at 50% → 300 mi at 100%.
    expect(maxRangeMiAtFull(150, 50)).toBeCloseTo(300, 6)
    expect(maxRangeMiAtFull(265, 100)).toBeCloseTo(265, 6)
  })
  it('guards missing/zero inputs', () => {
    expect(maxRangeMiAtFull(null, 50)).toBeNull()
    expect(maxRangeMiAtFull(150, 0)).toBeNull()
  })
})

describe('recentMean', () => {
  it('averages the most recent n finite values', () => {
    expect(recentMean([10, 20, 30, 40], 2)).toBeCloseTo(35, 6) // mean(30,40)
    expect(recentMean([5], 5)).toBeCloseTo(5, 6)
  })
  it('ignores non-finite values and returns null when empty', () => {
    expect(recentMean([NaN, Infinity])).toBeNull()
    expect(recentMean([])).toBeNull()
  })
})

describe('linearRegression', () => {
  it('recovers slope + intercept of a perfect line', () => {
    const fit = linearRegression([
      { x: 0, y: 2 },
      { x: 10, y: 4 },
      { x: 20, y: 6 },
    ])
    expect(fit?.slope).toBeCloseTo(0.2, 6)
    expect(fit?.intercept).toBeCloseTo(2, 6)
  })
  it('captures a downward degradation trend', () => {
    const fit = linearRegression([
      { x: 0, y: 75 },
      { x: 5000, y: 74 },
      { x: 10000, y: 72.5 },
    ])
    expect(fit?.slope).toBeLessThan(0)
  })
  it('returns null with <2 points or zero x-variance', () => {
    expect(linearRegression([{ x: 1, y: 1 }])).toBeNull()
    expect(linearRegression([{ x: 5, y: 1 }, { x: 5, y: 9 }])).toBeNull()
  })
})

describe('odometerForTime', () => {
  const odo: OdoSample[] = [
    { at: '2026-01-01T00:00:00Z', odometer: 100 },
    { at: '2026-02-01T00:00:00Z', odometer: 500 },
    { at: '2026-03-01T00:00:00Z', odometer: 900 },
  ]
  it('returns the last odometer at or before the moment', () => {
    expect(odometerForTime(odo, '2026-02-15T00:00:00Z')).toBe(500)
    expect(odometerForTime(odo, '2026-02-01T00:00:00Z')).toBe(500) // inclusive
    expect(odometerForTime(odo, '2026-05-01T00:00:00Z')).toBe(900)
  })
  it('falls back to the earliest sample before the first one, null when empty', () => {
    expect(odometerForTime(odo, '2025-06-01T00:00:00Z')).toBe(100)
    expect(odometerForTime([], '2026-01-01T00:00:00Z')).toBeNull()
  })
})

describe('buildBatteryReadings', () => {
  const odo: OdoSample[] = [
    { at: '2026-01-10T00:00:00Z', odometer: 1000 },
    { at: '2026-02-10T00:00:00Z', odometer: 4000 },
  ]
  it('computes capacity + max-range per charge and attaches the nearest odometer', () => {
    const readings = buildBatteryReadings(
      [
        { date: '2026-02-15T00:00:00Z', endRangeMi: 150, endSoc: 50 },
        { date: '2026-01-12T00:00:00Z', endRangeMi: 260, endSoc: 100 },
      ],
      odo,
      250,
    )
    // sorted chronologically
    expect(readings.map((r) => r.date)).toEqual([
      '2026-01-12T00:00:00Z',
      '2026-02-15T00:00:00Z',
    ])
    // Jan reading → odometer from the Jan-10 drive (1000); Feb → Feb-10 (4000).
    expect(readings[0].odometerMi).toBe(1000)
    expect(readings[1].odometerMi).toBe(4000)
    // capacity: 150mi @50% @250Wh/mi → 75 kWh; max range → 300 mi.
    expect(readings[1].capacityKwh).toBeCloseTo(75, 6)
    expect(readings[1].maxRangeMi).toBeCloseTo(300, 6)
    expect(readings[0].maxRangeMi).toBeCloseTo(260, 6)
  })
  it('still yields max range when efficiency is unknown (capacity null)', () => {
    const [r] = buildBatteryReadings(
      [{ date: '2026-02-15T00:00:00Z', endRangeMi: 150, endSoc: 50 }],
      odo,
      null,
    )
    expect(r.capacityKwh).toBeNull()
    expect(r.maxRangeMi).toBeCloseTo(300, 6)
  })
})

describe('binConsumptionByTemp', () => {
  it('bins points by temperature and averages Wh/mi', () => {
    const bins = binConsumptionByTemp(
      [
        { tempC: 1, whPerMi: 300 },
        { tempC: 2, whPerMi: 320 },
        { tempC: 21, whPerMi: 240 },
      ],
      5,
    )
    const cold = bins.find((b) => b.tempC === 0)
    expect(cold?.avgWhPerMi).toBeCloseTo(310, 6)
    expect(cold?.count).toBe(2)
    expect(bins.find((b) => b.tempC === 20)?.avgWhPerMi).toBe(240)
  })
})

describe('bucketMileage', () => {
  const rows = [
    { started_at: '2025-01-05T10:00:00Z', distance_mi: 10, end_odometer: 1010 },
    { started_at: '2025-01-20T10:00:00Z', distance_mi: 20, end_odometer: 1030 },
    { started_at: '2025-02-02T10:00:00Z', distance_mi: 5, end_odometer: 1035 },
  ]
  it('sums distance + carries last odometer per month', () => {
    const b = bucketMileage(rows, 'month')
    expect(b).toHaveLength(2)
    expect(b[0]).toEqual({ period: '2025-01', distanceMi: 30, endOdometerMi: 1030 })
    expect(b[1]).toEqual({ period: '2025-02', distanceMi: 5, endOdometerMi: 1035 })
  })
  it('keys by year and day too', () => {
    expect(periodKey('2025-03-15T00:00:00Z', 'year')).toBe('2025')
    expect(periodKey('2025-03-15T00:00:00Z', 'day')).toBe('2025-03-15')
  })
})

describe('mergeTimeline', () => {
  it('orders events newest-first', () => {
    const out = mergeTimeline([
      { kind: 'drive', at: '2025-01-01T00:00:00Z', title: 'a' },
      { kind: 'charge', at: '2025-03-01T00:00:00Z', title: 'b' },
      { kind: 'state', at: '2025-02-01T00:00:00Z', title: 'c' },
    ])
    expect(out.map((e) => e.title)).toEqual(['b', 'c', 'a'])
  })
})

describe('buildPhantomDrain', () => {
  const park = (at: string, mi: number): PhantomSnap => ({ est: mi, rng: mi, charging: null, shift: 'P', at })

  it('sums parked+unplugged range drops and buckets them per UTC day', () => {
    const r = buildPhantomDrain([
      park('2026-06-01T00:00:00Z', 200),
      park('2026-06-01T12:00:00Z', 198), // -2 on day 1
      park('2026-06-02T00:00:00Z', 195), // -3 on day 2
    ])
    expect(r.hasData).toBe(true)
    expect(r.lostMi).toBeCloseTo(5, 6)
    expect(r.series).toEqual([
      { date: '2026-06-01', lostMi: 2 },
      { date: '2026-06-02', lostMi: 3 },
    ])
  })

  it('ignores charging, driving, and gap-sized jumps', () => {
    const r = buildPhantomDrain([
      park('2026-06-01T00:00:00Z', 200),
      { est: 230, rng: 230, charging: 'Charging', shift: null, at: '2026-06-01T01:00:00Z' }, // charging gain — skip
      { est: 100, rng: 100, charging: null, shift: 'D', at: '2026-06-01T02:00:00Z' }, // driving — skip
      park('2026-06-01T03:00:00Z', 80), // prev was driving → pair skipped
      park('2026-06-01T04:00:00Z', 200), // +120 jump (gap) → not a drop
    ])
    expect(r.lostMi).toBe(0)
    expect(r.hasData).toBe(false)
  })
})

describe('buildPhantomCauses', () => {
  const snap = (at: string, mi: number, over: Partial<PhantomCauseSnap> = {}): PhantomCauseSnap => ({
    est: mi,
    rng: mi,
    charging: null,
    shift: 'P',
    at,
    outsideC: 20,
    sentry: null,
    climateOn: null,
    ...over,
  })

  // Each cause tested as an isolated pair (attribution reads both endpoints, so
  // adjacent intervals would otherwise bleed flags into each other).
  const cause = (a: Partial<PhantomCauseSnap>, b: Partial<PhantomCauseSnap>) =>
    buildPhantomCauses([
      snap('2026-06-01T00:00:00Z', 200, a),
      snap('2026-06-01T00:02:00Z', 197, b),
    ]).slices[0]?.cause

  it('attributes by priority: sentry > climate > cold > awake', () => {
    expect(cause({ sentry: true }, { sentry: true, climateOn: true })).toBe('sentry')
    expect(cause({ climateOn: true }, { climateOn: true, outsideC: 0 })).toBe('climate')
    expect(cause({ outsideC: 0 }, { outsideC: 0 })).toBe('cold')
    expect(cause({}, {})).toBe('awake') // warm, parked, no flags
  })

  it('preconditioning counts as climate (climateOn folds is_preconditioning)', () => {
    expect(cause({ climateOn: true }, { climateOn: true })).toBe('climate')
  })

  it('attributes a drop across a long sample gap to asleep baseline', () => {
    const r = buildPhantomCauses([
      snap('2026-06-01T00:00:00Z', 200, { sentry: true }), // sentry flag present...
      snap('2026-06-01T06:00:00Z', 197), // ...but 6h gap ⇒ slept ⇒ asleep, not sentry
    ])
    expect(r.slices).toEqual([{ cause: 'asleep', lostMi: 3, pct: 100 }])
  })

  it('ignores charging and driving intervals', () => {
    const r = buildPhantomCauses([
      snap('2026-06-01T00:00:00Z', 200),
      snap('2026-06-01T00:02:00Z', 198, { charging: 'Charging' }),
      snap('2026-06-01T00:04:00Z', 196, { shift: 'D' }),
    ])
    expect(r.hasData).toBe(false)
  })
})

describe('sumChargeEnergyAdded', () => {
  it('returns the final peak for a single monotonic charge', () => {
    expect(sumChargeEnergyAdded([0, 5, 12, 28, 41.2])).toBeCloseTo(41.2, 6)
  })

  it('does NOT re-bank on sample noise (the 193 kWh bug)', () => {
    // A ~40 kWh charge that wiggles down by rounding noise must stay ~40, not balloon.
    const noisy = [0, 10, 9.9, 20, 19.8, 30, 29.9, 40, 39.9, 41]
    expect(sumChargeEnergyAdded(noisy)).toBeCloseTo(41, 6)
  })

  it('sums across a genuine reset (two physical charges in one window)', () => {
    // 0→40, reset to 0, 0→35 ⇒ 75 total.
    expect(sumChargeEnergyAdded([0, 20, 40, 0.3, 15, 35])).toBeCloseTo(75, 6)
  })

  it('returns null with no readings', () => {
    expect(sumChargeEnergyAdded([])).toBeNull()
  })
})

describe('integrateGridEnergyKwh / measuredLossPct', () => {
  it('trapezoid-integrates V×A×phases over time into kWh', () => {
    // 240V × 30A × 1φ = 7200W held for 1h = 7.2 kWh.
    const kwh = integrateGridEnergyKwh([
      { at: '2026-06-01T00:00:00Z', voltage: 240, current: 30, phases: 1 },
      { at: '2026-06-01T01:00:00Z', voltage: 240, current: 30, phases: 1 },
    ])
    expect(kwh).toBeCloseTo(7.2, 6)
  })

  it('returns null without two valid V/A/phases samples', () => {
    expect(integrateGridEnergyKwh([{ at: '2026-06-01T00:00:00Z', voltage: 240, current: null, phases: 1 }])).toBeNull()
  })

  it('computes loss only inside a believable band', () => {
    expect(measuredLossPct(10, 9)).toBeCloseTo(10, 6) // 10% loss
    expect(measuredLossPct(10, 11)).toBeNull() // negative loss → rejected
    expect(measuredLossPct(10, 5)).toBeNull() // 50% → implausible, rejected
    expect(measuredLossPct(null, 9)).toBeNull()
  })
})
