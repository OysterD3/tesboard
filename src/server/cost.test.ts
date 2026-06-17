import { describe, expect, it } from 'vitest'
import { computeChargeCost, parseTouSchedule, touWeightedRate, type TouSchedule } from './cost'
import { findGeofence } from './geo'

const home = { flat_rate: 0.15, loss_factor: 1.1, currency: 'USD' }

// All TOU tests use utcOffsetMin: 0, so ISO-Z times map directly to local minutes.
const SCHED: TouSchedule = {
  utcOffsetMin: 0,
  defaultRate: 0.25,
  bands: [
    { name: 'Off', rate: 0.1, startMin: 0, endMin: 360 }, // 00:00–06:00
    { name: 'Peak', rate: 0.4, startMin: 960, endMin: 1260 }, // 16:00–21:00
  ],
}

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

describe('touWeightedRate', () => {
  it('charge fully inside one band → that band rate', () => {
    const r = touWeightedRate(SCHED, '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z')
    expect(r).toBeCloseTo(0.1, 6)
  })

  it('charge straddling a band edge → time-weighted average with default', () => {
    // 05:30–06:30: 30 min in Off (0.10), 30 min uncovered (default 0.25).
    const r = touWeightedRate(SCHED, '2026-01-01T05:30:00Z', '2026-01-01T06:30:00Z')
    expect(r).toBeCloseTo((30 * 0.1 + 30 * 0.25) / 60, 4)
  })

  it('overnight band wraps past midnight', () => {
    const wrap: TouSchedule = { utcOffsetMin: 0, defaultRate: 0.3, bands: [{ name: 'Night', rate: 0.1, startMin: 1320, endMin: 120 }] }
    const r = touWeightedRate(wrap, '2026-01-01T23:00:00Z', '2026-01-02T01:00:00Z')
    expect(r).toBeCloseTo(0.1, 6)
  })

  it('weekday-scoped band only applies on weekdays', () => {
    const wk: TouSchedule = { utcOffsetMin: 0, defaultRate: 0.3, bands: [{ name: 'Cheap', rate: 0.1, startMin: 0, endMin: 1440, days: [1, 2, 3, 4, 5] }] }
    // 2026-01-01 is a Thursday (weekday) → band; 2026-01-03 is Saturday → default.
    expect(touWeightedRate(wk, '2026-01-01T01:00:00Z', '2026-01-01T02:00:00Z')).toBeCloseTo(0.1, 6)
    expect(touWeightedRate(wk, '2026-01-03T01:00:00Z', '2026-01-03T02:00:00Z')).toBeCloseTo(0.3, 6)
  })

  it('no window → null', () => {
    expect(touWeightedRate(SCHED, null, null)).toBeNull()
  })
})

describe('parseTouSchedule', () => {
  it('returns null for non-objects / empty', () => {
    expect(parseTouSchedule(null)).toBeNull()
    expect(parseTouSchedule([])).toBeNull()
    expect(parseTouSchedule({ bands: [] })).toBeNull()
  })
  it('parses valid bands and drops malformed ones', () => {
    const s = parseTouSchedule({
      bands: [
        { name: 'Off', rate: 0.1, startMin: 0, endMin: 360 },
        { name: 'bad', rate: 'x', startMin: 0, endMin: 1 }, // dropped
      ],
      defaultRate: 0.25,
      utcOffsetMin: -420,
    })
    expect(s?.bands.length).toBe(1)
    expect(s?.utcOffsetMin).toBe(-420)
  })
})

describe('computeChargeCost (time-of-use)', () => {
  it('TOU schedule overrides flat rate for home charges', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      isHome: true,
      homeRate: { ...home, tou: SCHED },
      startedAt: '2026-01-01T01:00:00Z',
      endedAt: '2026-01-01T02:00:00Z',
    })
    // Off-peak 0.10 × 10 kWh × 1.1 loss.
    expect(r.cost_amount).toBeCloseTo(10 * 0.1 * 1.1, 6)
    expect(r.cost_source).toBe('computed')
    expect(r.rate_applied).toBeCloseTo(0.1, 6)
  })

  it('falls back to flat rate when the window is missing', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      isHome: true,
      homeRate: { ...home, tou: SCHED },
    })
    expect(r.cost_amount).toBeCloseTo(10 * 0.15 * 1.1, 6)
    expect(r.rate_applied).toBe(0.15)
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
