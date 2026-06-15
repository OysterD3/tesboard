import { describe, expect, it } from 'vitest'
import {
  binConsumptionByTemp,
  bucketMileage,
  buildBatteryHealth,
  capacityKwh,
  mergeTimeline,
  periodKey,
  projectedRangeMi,
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
