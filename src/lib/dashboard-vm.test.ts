import { describe, expect, it } from 'vitest'
import { buildChargingReview } from './dashboard-vm'
import type { ChargingPayload } from '../functions/charging.functions'
import type { ChargeWithLocation } from '../functions/charging.functions'

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
