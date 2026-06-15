import { describe, expect, it } from 'vitest'
import { computeChargeCost } from './cost'
import { findGeofence } from './geo'

const home = { flat_rate: 0.15, loss_factor: 1.1, currency: 'USD' }

describe('computeChargeCost', () => {
  it('free supercharging → 0, tesla_billed_free', () => {
    const r = computeChargeCost({
      source: 'supercharger',
      freeSupercharging: true,
      energyAddedKwh: 40,
    })
    expect(r.cost_amount).toBe(0)
    expect(r.cost_source).toBe('tesla_billed_free')
  })

  it('paid supercharger → null (reconcile fills it)', () => {
    const r = computeChargeCost({ source: 'supercharger', energyAddedKwh: 40 })
    expect(r.cost_amount).toBeNull()
    expect(r.cost_source).toBe('computed')
  })

  it('geofence per_kwh uses MAX(used, added) × rate + session fee', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      energyUsedKwh: 11,
      geofence: { billing_type: 'per_kwh', cost_per_unit: 0.2, session_fee: 1, currency: 'EUR', is_home: false },
    })
    expect(r.cost_amount).toBeCloseTo(11 * 0.2 + 1, 6)
    expect(r.cost_source).toBe('geofence')
    expect(r.cost_currency).toBe('EUR')
  })

  it('geofence per_minute uses minutes × rate + fee', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      durationS: 1800, // 30 min
      geofence: { billing_type: 'per_minute', cost_per_unit: 0.1, session_fee: 0.5, currency: null, is_home: false },
    })
    expect(r.cost_amount).toBeCloseTo(30 * 0.1 + 0.5, 6)
  })

  it('geofence per_session → just the session fee', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      geofence: { billing_type: 'per_session', cost_per_unit: null, session_fee: 3, currency: 'USD', is_home: false },
    })
    expect(r.cost_amount).toBe(3)
    expect(r.cost_source).toBe('geofence')
  })

  it('home flat-rate fallback applies energy × rate × loss', () => {
    const r = computeChargeCost({ source: 'home', energyAddedKwh: 10, isHome: true, homeRate: home })
    expect(r.cost_amount).toBeCloseTo(10 * 0.15 * 1.1, 6)
    expect(r.cost_source).toBe('computed')
    expect(r.rate_applied).toBe(0.15)
  })

  it('away AC charge with no rule → null', () => {
    const r = computeChargeCost({ source: 'home', energyAddedKwh: 10, isHome: false, homeRate: home })
    expect(r.cost_amount).toBeNull()
  })
})

describe('findGeofence (nearest-wins within radius)', () => {
  const zones = [
    { id: 1, lat: 37.0, lng: -122.0, radius_m: 150 },
    { id: 2, lat: 37.0009, lng: -122.0, radius_m: 500 }, // ~100 m north, bigger zone
  ]
  it('returns the nearest containing zone when zones overlap', () => {
    // A point right on zone 1's centre is inside both, but zone 1 is nearer.
    expect(findGeofence(37.0, -122.0, zones)?.id).toBe(1)
  })
  it('returns null when outside every zone', () => {
    expect(findGeofence(38.0, -122.0, zones)).toBeNull()
  })
  it('returns null for missing coords', () => {
    expect(findGeofence(null, -122.0, zones)).toBeNull()
  })
})
