import { describe, expect, it } from 'vitest'
import {
  KM_TO_MI,
  chargeLocationType,
  downsampleByInterval,
  driveEnergyKwh,
  efficiencyKwhPerKmToWhPerMi,
  isDcFastCharge,
  kmToMi,
  mapBillingType,
  mapChargeCost,
  minutesToSeconds,
  whPerMi,
} from './convert.mjs'

describe('distance/speed conversion', () => {
  it('converts km to mi with the exact statute ratio', () => {
    expect(kmToMi(1.609344)).toBeCloseTo(1, 10)
    expect(kmToMi(100)).toBeCloseTo(62.1371, 3)
  })
  it('passes null/NaN through as null', () => {
    expect(kmToMi(null)).toBeNull()
    expect(kmToMi(undefined)).toBeNull()
    expect(kmToMi(NaN)).toBeNull()
  })
  it('KM_TO_MI is the inverse of 1.609344', () => {
    expect(KM_TO_MI).toBeCloseTo(0.621371, 6)
  })
})

describe('efficiency', () => {
  it('kWh/km → Wh/mi', () => {
    // 0.15 kWh/km = 150 Wh/km = 150 * 1.609344 ≈ 241.4 Wh/mi
    expect(efficiencyKwhPerKmToWhPerMi(0.15)).toBeCloseTo(241.4, 1)
  })
  it('rejects non-positive / null', () => {
    expect(efficiencyKwhPerKmToWhPerMi(0)).toBeNull()
    expect(efficiencyKwhPerKmToWhPerMi(null)).toBeNull()
  })
})

describe('driveEnergyKwh', () => {
  it('uses range drop × efficiency', () => {
    // 50 km of rated-range drop at 0.15 kWh/km = 7.5 kWh
    expect(driveEnergyKwh(300, 250, 0.15)).toBeCloseTo(7.5, 6)
  })
  it('returns null on net charge (negative delta) or missing inputs', () => {
    expect(driveEnergyKwh(250, 300, 0.15)).toBeNull()
    expect(driveEnergyKwh(300, 250, null)).toBeNull()
    expect(driveEnergyKwh(null, 250, 0.15)).toBeNull()
  })
})

describe('whPerMi', () => {
  it('computes Wh/mi from kWh and miles', () => {
    expect(whPerMi(7.5, 31.07)).toBeCloseTo(241.4, 0)
  })
  it('guards sub-mile and zero/negative energy', () => {
    expect(whPerMi(7.5, 0.4)).toBeNull()
    expect(whPerMi(0, 10)).toBeNull()
    expect(whPerMi(null, 10)).toBeNull()
  })
})

describe('minutesToSeconds', () => {
  it('rounds minutes to seconds', () => {
    expect(minutesToSeconds(2.5)).toBe(150)
    expect(minutesToSeconds(null)).toBeNull()
  })
})

describe('charge classification + cost (energy is NEVER scaled)', () => {
  it('flags DC fast charge by type', () => {
    expect(isDcFastCharge('Supercharger', 'Tesla')).toBe(true)
    expect(isDcFastCharge('CCS', null)).toBe(true)
    expect(isDcFastCharge('<invalid>', null)).toBe(false)
    expect(isDcFastCharge(null, null)).toBe(false)
  })
  it('free supercharging → 0 cost, tesla_billed_free', () => {
    const r = mapChargeCost({ fastChargerType: 'Supercharger', freeSupercharging: true, tmCost: 12 })
    expect(r).toEqual({ source: 'supercharger', cost_source: 'tesla_billed_free', cost_amount: 0 })
  })
  it('paid supercharger keeps TeslaMate cost verbatim (no kWh scaling)', () => {
    const r = mapChargeCost({ fastChargerType: 'Supercharger', freeSupercharging: false, tmCost: 12.34 })
    expect(r).toEqual({ source: 'supercharger', cost_source: 'tesla_billed', cost_amount: 12.34 })
  })
  it('AC charge → imported_teslamate, null cost stays null', () => {
    const r = mapChargeCost({ fastChargerType: null, freeSupercharging: false, tmCost: null })
    expect(r).toEqual({ source: 'home', cost_source: 'imported_teslamate', cost_amount: null })
  })
  it('derives charge_location_type', () => {
    expect(chargeLocationType({ isDc: true })).toBe('supercharger')
    expect(chargeLocationType({ isDc: false, hasGeofence: true, geofenceIsHome: true })).toBe('home')
    expect(chargeLocationType({ isDc: false, hasGeofence: true, geofenceIsHome: false })).toBe('away')
    expect(chargeLocationType({ isDc: false, hasGeofence: false })).toBe('unknown')
  })
})

describe('mapBillingType', () => {
  it('maps the three billing modes, defaulting to per_kwh', () => {
    expect(mapBillingType('per_minute')).toBe('per_minute')
    expect(mapBillingType('per_session')).toBe('per_session')
    expect(mapBillingType('per_kwh')).toBe('per_kwh')
    expect(mapBillingType(null)).toBe('per_kwh')
  })
})

describe('downsampleByInterval', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, soc: i }))
  const tsOf = (r: { t: number }) => r.t
  it('always keeps first and last', () => {
    const out = downsampleByInterval(rows, 3, tsOf)
    expect(out[0]).toBe(rows[0])
    expect(out.at(-1)).toBe(rows.at(-1))
  })
  it('thins rows closer than the interval', () => {
    const out = downsampleByInterval(rows, 3, tsOf)
    expect(out.length).toBeLessThan(rows.length)
  })
  it('returns a copy when too few rows or no interval', () => {
    expect(downsampleByInterval(rows, 0, tsOf)).toHaveLength(rows.length)
    expect(downsampleByInterval([rows[0]], 5, tsOf)).toHaveLength(1)
  })
  it('force-keeps rows matching keepIf', () => {
    const out = downsampleByInterval(rows, 100, tsOf, (r) => r.soc === 5)
    expect(out.some((r) => r.soc === 5)).toBe(true)
  })
})
