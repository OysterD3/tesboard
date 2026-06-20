import { describe, expect, it } from 'vitest'
import { buildChargeInsights, buildChargingReview, buildDriveInsights, buildDrives, buildSessions } from './dashboard-vm'
import { resolveRange } from './range-filter'
import type { ChargingPayload } from '../functions/charging.functions'
import type { ChargeWithLocation } from '../functions/charging.functions'
import type { DrivesPayload, DriveWithLocation } from '../functions/drives.functions'

// Minimal session factory — only the fields buildChargingReview reads.
function session(over: Partial<ChargeWithLocation>): ChargeWithLocation {
  return {
    id: 1,
    vin: 'V',
    user_id: 'u',
    source: 'home',
    started_at: '2026-06-01T00:00:00Z',
    ended_at: '2026-06-01T01:00:00Z',
    location_name: null,
    lat: null,
    lng: null,
    energy_added_kwh: 10,
    energy_used_kwh: null,
    miles_added_rated: 30,
    start_range_mi: null,
    end_range_mi: null,
    start_battery_level: null,
    end_battery_level: null,
    outside_temp_avg: null,
    fast_charger_type: null,
    charge_location_type: 'home',
    geofence_id: null,
    address_id: null,
    cost_amount: 2,
    cost_currency: 'USD',
    cost_source: 'computed',
    import_source: 'live',
    source_pk: null,
    locationName: 'Home',
    ...over,
  } as ChargeWithLocation
}

const payload = (sessions: ChargeWithLocation[]): ChargingPayload => ({
  sessions,
  stats: {
    sessionCount: sessions.length,
    totalEnergyKwh: 0,
    totalCost: 0,
    currency: 'USD',
    superchargerCost: 0,
    homeCost: 0,
    totalMilesAdded: 0,
    avgCostPerKwh: null,
    avgCostPerMile: null,
  },
})

describe('buildChargingReview', () => {
  it('totals sessions/energy/cost and splits home vs supercharger energy', () => {
    const r = buildChargingReview(
      payload([
        session({ id: 1, energy_added_kwh: 30, cost_amount: 6, locationName: 'Home', source: 'home' }),
        session({ id: 2, energy_added_kwh: 10, cost_amount: 8, locationName: 'SC Bay', source: 'supercharger' }),
      ]),
    )
    expect(r.hasData).toBe(true)
    expect(r.sessions).toBe(2)
    expect(r.energyKwh).toBeCloseTo(40, 6)
    expect(r.cost).toBeCloseTo(14, 6)
    expect(r.homeEnergyPct).toBeCloseTo(0.75, 6) // 30 of 40 kWh at home
    expect(r.topLocations[0]).toMatchObject({ name: 'Home', sessions: 1 })
  })

  it('anchors the 12-month window on the latest session, not the wall clock', () => {
    const r = buildChargingReview(
      payload([
        session({ id: 1, started_at: '2024-01-01T00:00:00Z' }), // >365d before the latest → excluded
        session({ id: 2, started_at: '2026-06-01T00:00:00Z' }),
      ]),
    )
    expect(r.sessions).toBe(1)
  })

  it('returns an empty review with no sessions', () => {
    expect(buildChargingReview(payload([])).hasData).toBe(false)
  })
})

// Minimal drive factory — only the fields buildDrives reads.
function drive(over: Partial<DriveWithLocation>): DriveWithLocation {
  return {
    id: 1,
    vin: 'V',
    user_id: 'u',
    started_at: '2026-04-20T19:14:00Z',
    ended_at: '2026-04-20T19:32:00Z',
    distance_mi: 3.42,
    duration_s: 1080,
    start_lat: 3.1,
    start_lng: 101.7,
    end_lat: 3.2,
    end_lng: 101.65,
    start_battery_level: 58,
    end_battery_level: 56,
    energy_used_kwh: 1.2,
    wh_per_mi: 300,
    startLocation: 'Kuala Lumpur, Malaysia',
    endLocation: 'Batu Caves, Kuala Lumpur',
    ...over,
  } as DriveWithLocation
}

const drivesPayload = (drives: DriveWithLocation[]): DrivesPayload => ({
  drives,
  stats: { driveCount: drives.length, totalMiles: 0, totalEnergyKwh: 0, avgWhPerMi: null },
})

describe('buildDrives', () => {
  it('exposes per-endpoint place, battery and tz-safe stamps', () => {
    const [d] = buildDrives(drivesPayload([drive({})]), 'UTC')
    expect(d.startPlace).toBe('Kuala Lumpur, Malaysia')
    expect(d.endPlace).toBe('Batu Caves, Kuala Lumpur')
    expect(d.startBattery).toBe(58)
    expect(d.endBattery).toBe(56)
    expect(d.startStamp).toBe('Mon, Apr 20 · 7:14 PM')
    expect(d.endStamp).toBe('Mon, Apr 20 · 7:32 PM')
  })

  it('leaves endStamp null for an in-progress drive', () => {
    const [d] = buildDrives(drivesPayload([drive({ ended_at: null, end_battery_level: null, endLocation: null })]), 'UTC')
    expect(d.endStamp).toBeNull()
    expect(d.endBattery).toBeNull()
    expect(d.endPlace).toBeNull()
    expect(d.startStamp).toBe('Mon, Apr 20 · 7:14 PM')
  })

  it('keeps null places null (un-geocoded live drive) for the route to label', () => {
    const [d] = buildDrives(drivesPayload([drive({ startLocation: null, endLocation: null })]), 'UTC')
    expect(d.startPlace).toBeNull()
    expect(d.endPlace).toBeNull()
  })
})

describe('buildSessions', () => {
  it('exposes per-end battery + tz-safe stamps for the From→To charge card', () => {
    const [s] = buildSessions(
      payload([
        session({
          started_at: '2026-04-18T17:20:00Z',
          ended_at: '2026-04-18T17:32:00Z',
          start_battery_level: 98,
          end_battery_level: 100,
        }),
      ]),
      'UTC',
    )
    expect(s.startBattery).toBe(98)
    expect(s.endBattery).toBe(100)
    expect(s.startStamp).toBe('Sat, Apr 18 · 5:20 PM')
    expect(s.endStamp).toBe('Sat, Apr 18 · 5:32 PM')
    expect(s.type).toBe('AC')
  })

  it('leaves endStamp null for an in-progress charge', () => {
    const [s] = buildSessions(payload([session({ ended_at: null, end_battery_level: null })]), 'UTC')
    expect(s.endStamp).toBeNull()
    expect(s.endBattery).toBeNull()
  })
})

// Anchor "now" so the relative windows are deterministic.
const NOW = Date.parse('2026-06-20T12:00:00.000Z')
const KM_PER_MI = 1.60934

describe('buildDriveInsights', () => {
  const drives = [
    drive({ id: 1, started_at: '2026-06-19T10:00:00Z', distance_mi: 10, wh_per_mi: 250 }), // in 7d
    drive({ id: 2, started_at: '2026-06-15T10:00:00Z', distance_mi: 50, wh_per_mi: 200 }), // in 7d (longest, most eff)
    drive({ id: 3, started_at: '2026-05-01T10:00:00Z', distance_mi: 99, wh_per_mi: 150 }), // outside 7d/30d
  ]
  const charges = [
    session({ id: 1, started_at: '2026-06-18T10:00:00Z', cost_amount: 4, cost_currency: 'USD' }), // in 7d
    session({ id: 2, started_at: '2026-05-01T10:00:00Z', cost_amount: 99, cost_currency: 'USD' }), // outside
  ]

  it('windows milestones to the last 7 days', () => {
    const vm = buildDriveInsights(drives, charges, resolveRange({ key: '7d' }, NOW))
    expect(vm.hasDrives).toBe(true)
    expect(vm.count).toBe(2)
    expect(vm.daysDriven).toBe(2)
    // km fields round to whole units (mirrors buildInsights).
    expect(vm.longestKm).toBe(Math.round(50 * KM_PER_MI)) // 80
    expect(vm.mostEffWhKm).toBe(Math.round(200 / KM_PER_MI)) // 124
    expect(vm.distKm).toBe(Math.round(60 * KM_PER_MI)) // 97
    expect(vm.spend).toBe(4) // only the in-window charge
  })

  it('all-time includes every drive', () => {
    const vm = buildDriveInsights(drives, charges, resolveRange({ key: 'all' }, NOW))
    expect(vm.count).toBe(3)
    expect(vm.longestKm).toBe(Math.round(99 * KM_PER_MI)) // 159
    expect(vm.spend).toBe(103)
  })

  it('empty window reports no drives', () => {
    const vm = buildDriveInsights([], [], resolveRange({ key: '7d' }, NOW))
    expect(vm.hasDrives).toBe(false)
    expect(vm.daysDriven).toBeNull()
    expect(vm.longestKm).toBeNull()
    expect(vm.spend).toBeNull()
  })
})

describe('buildChargeInsights', () => {
  const charges = [
    session({ id: 1, started_at: '2026-06-18T10:00:00Z', source: 'home', cost_amount: 6, miles_added_rated: 30 }),
    session({ id: 2, started_at: '2026-06-14T10:00:00Z', source: 'supercharger', cost_amount: 14, miles_added_rated: 70 }),
    session({ id: 3, started_at: '2026-04-01T10:00:00Z', source: 'home', cost_amount: 99, miles_added_rated: 500 }),
  ]

  it('windows cost of ownership to the last 7 days', () => {
    const vm = buildChargeInsights(charges, resolveRange({ key: '7d' }, NOW))
    expect(vm.hasCharge).toBe(true)
    expect(vm.spend).toBe(20) // 6 + 14, excludes April
    expect(vm.costPerMi).toBeCloseTo(20 / 100, 4) // (6+14) / (30+70)
    expect(vm.homePct).toBeCloseTo(6 / 20, 4)
    expect(vm.costPerMonth).not.toBeNull()
  })

  it('all-time spend sums every session', () => {
    const vm = buildChargeInsights(charges, resolveRange({ key: 'all' }, NOW))
    expect(vm.spend).toBe(119)
  })

  it('empty window reports no charge data', () => {
    const vm = buildChargeInsights([], resolveRange({ key: '7d' }, NOW))
    expect(vm.hasCharge).toBe(false)
    expect(vm.spend).toBeNull()
    expect(vm.homePct).toBeNull()
  })
})
