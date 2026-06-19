import { describe, expect, it } from 'vitest'
import { buildChargeDetail } from './charge-detail-vm'
import type { ChargeDetailPayload, ChargeSampleRaw } from '../functions/charge-detail.functions'
import type { ChargeWithLocation } from '../functions/charging.functions'

const KM_PER_MI = 1.60934

function charge(over: Partial<ChargeWithLocation> = {}): ChargeWithLocation {
  return {
    id: 1,
    vin: 'V1',
    user_id: 'u1',
    source: 'home',
    started_at: '2026-04-18T17:20:00Z',
    ended_at: '2026-04-18T17:32:00Z',
    location_name: null,
    lat: 3.1,
    lng: 101.7,
    energy_added_kwh: 0.94,
    energy_used_kwh: 0.94,
    miles_added_rated: 4.1,
    start_range_mi: 261.5,
    end_range_mi: 267.0,
    start_battery_level: 98,
    end_battery_level: 100,
    outside_temp_avg: 30.5,
    fast_charger_type: null,
    charge_location_type: 'home',
    geofence_id: null,
    address_id: null,
    cost_amount: 0.92,
    cost_currency: 'USD',
    cost_source: 'computed',
    rate_applied: 0.28,
    tesla_charge_session_id: null,
    invoices: null,
    import_source: 'live',
    source_pk: null,
    created_at: '2026-04-18T17:32:00Z',
    updated_at: '2026-04-18T17:32:00Z',
    locationName: 'Batu Caves, Kuala Lumpur',
    ...over,
  } as ChargeWithLocation
}

function sample(over: Partial<ChargeSampleRaw> = {}): ChargeSampleRaw {
  return { tMin: 0, soc: null, rangeMi: null, powerKw: null, currentA: null, voltageV: null, insideC: null, outsideC: null, ...over }
}

function payload(over: Partial<ChargeDetailPayload> = {}): ChargeDetailPayload {
  return { charge: charge(), samples: [], point: [3.1, 101.7], odometerMi: 1552, sinceLastChargeMi: 0, ...over }
}

describe('buildChargeDetail', () => {
  it('reports not-found for a null charge', () => {
    const vm = buildChargeDetail(payload({ charge: null }))
    expect(vm.found).toBe(false)
    expect(vm.series.soc).toEqual([])
  })

  it('surfaces place, type, battery and tz-safe stamps + subtitle', () => {
    const vm = buildChargeDetail(payload(), 'UTC')
    expect(vm.place).toBe('Batu Caves, Kuala Lumpur')
    expect(vm.title).toBe('Batu Caves, Kuala Lumpur')
    expect(vm.typeLabel).toBe('AC')
    expect(vm.isFast).toBe(false)
    expect(vm.batteryStart).toBe(98)
    expect(vm.batteryEnd).toBe(100)
    expect(vm.startStamp).toBe('Sat, Apr 18 · 5:20 PM')
    expect(vm.endStamp).toBe('Sat, Apr 18 · 5:32 PM')
    expect(vm.subtitle).toBe('Apr 18 · 5:20 PM – 5:32 PM')
    expect(vm.durMin).toBe(12)
  })

  it('uses a neutral title (not a duplicated date) when no place resolves', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ locationName: null }) }), 'UTC')
    expect(vm.place).toBeNull()
    expect(vm.title).toBe('Charge session')
    expect(vm.subtitle).toBe('Apr 18 · 5:20 PM – 5:32 PM')
  })

  it('labels a supercharger session DC fast', () => {
    expect(buildChargeDetail(payload({ charge: charge({ source: 'supercharger' }) })).typeLabel).toBe('DC fast')
  })

  it('passes cost through from the charge row, rounded to cents', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ cost_amount: 0.9249, cost_currency: 'USD' }) }))
    expect(vm.cost).toEqual({ amount: 0.92, currency: 'USD' })
  })

  it('computes charging efficiency = added ÷ used', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ energy_added_kwh: 9, energy_used_kwh: 10 }) }))
    expect(vm.effPct).toBe(90)
    expect(vm.usedKwh).toBe(10)
    expect(vm.addedKwh).toBe(9)
  })

  it('leaves efficiency null when grid energy is unknown', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ energy_used_kwh: null }) }))
    expect(vm.effPct).toBeNull()
    expect(vm.usedKwh).toBeNull()
  })

  it('derives range added (km) from the rated-range delta', () => {
    const vm = buildChargeDetail(payload())
    expect(vm.rangeAddedKm).toBeCloseTo((267 - 261.5) * KM_PER_MI, 1)
  })

  it('converts odometer + since-last-charge from miles to km', () => {
    const vm = buildChargeDetail(payload({ odometerMi: 100, sinceLastChargeMi: 10 }))
    expect(vm.odometerKm).toBeCloseTo(100 * KM_PER_MI, 1)
    expect(vm.sinceLastChargeKm).toBeCloseTo(10 * KM_PER_MI, 1)
  })

  it('leaves odometer/since null when the server couldn’t derive them (telemetry gap)', () => {
    const vm = buildChargeDetail(payload({ odometerMi: null, sinceLastChargeMi: null }))
    expect(vm.odometerKm).toBeNull()
    expect(vm.sinceLastChargeKm).toBeNull()
  })

  it('builds per-metric series (range in km), dropping null samples', () => {
    const vm = buildChargeDetail(
      payload({
        samples: [
          sample({ tMin: 0, soc: 98, rangeMi: 261, powerKw: 7, currentA: 10, voltageV: 240, insideC: 32, outsideC: 30 }),
          sample({ tMin: 6, soc: 100, rangeMi: 267, powerKw: 3, currentA: 5, voltageV: 236 }),
          sample({ tMin: 12, powerKw: 0 }),
        ],
      }),
    )
    expect(vm.series.soc).toEqual([
      { x: 0, y: 98 },
      { x: 6, y: 100 },
    ])
    expect(vm.series.powerKw).toHaveLength(3)
    expect(vm.series.rangeKm[0].y).toBeCloseTo(261 * KM_PER_MI, 1)
    expect(vm.series.voltageV).toEqual([
      { x: 0, y: 240 },
      { x: 6, y: 236 },
    ])
  })

  it('derives power/current/voltage averages and peaks, showing charge power as a positive magnitude', () => {
    const vm = buildChargeDetail(
      payload({
        samples: [
          // Tesla reports charge power as negative (energy into the battery).
          sample({ tMin: 0, powerKw: -4, currentA: 6, voltageV: 230 }),
          sample({ tMin: 5, powerKw: -8, currentA: 10, voltageV: 240 }),
        ],
      }),
    )
    expect(vm.series.powerKw).toEqual([
      { x: 0, y: 4 },
      { x: 5, y: 8 },
    ])
    expect(vm.powerAvgKw).toBe(6)
    expect(vm.powerPeakKw).toBe(8)
    expect(vm.currentAvgA).toBe(8)
    expect(vm.currentPeakA).toBe(10)
    expect(vm.voltageAvgV).toBe(235)
    expect(vm.voltagePeakV).toBe(240)
  })

  it('falls back to the stored outside-temp average when there are no exterior samples', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ outside_temp_avg: 30.5 }), samples: [] }))
    expect(vm.outsideAvgC).toBe(30.5)
  })

  it('leaves endStamp null and duration zero for an in-progress charge', () => {
    const vm = buildChargeDetail(payload({ charge: charge({ ended_at: null, end_battery_level: null }) }), 'UTC')
    expect(vm.endStamp).toBeNull()
    expect(vm.durMin).toBe(0)
    expect(vm.batteryEnd).toBeNull()
  })
})
