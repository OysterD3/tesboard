import { describe, expect, it } from 'vitest'
import { buildIdleDetail, buildIdles, fmtIdleDuration } from './idles-vm'
import type { DriveWithLocation } from '../functions/drives.functions'
import type { IdleDetailPayload, IdleSampleRaw, IdleStateSpan } from '../functions/idle-detail.functions'

const KM_PER_MI = 1.60934

function drive(over: Partial<DriveWithLocation> = {}): DriveWithLocation {
  return {
    id: 1,
    vin: 'V1',
    user_id: 'u1',
    started_at: '2026-06-18T14:00:00Z',
    ended_at: '2026-06-18T14:30:00Z',
    start_odometer: 1000,
    end_odometer: 1020,
    distance_mi: 20,
    duration_s: 1800,
    start_lat: 1,
    start_lng: 2,
    end_lat: 3,
    end_lng: 4,
    start_battery_level: 80,
    end_battery_level: 60,
    start_range_mi: 240,
    end_range_mi: 200,
    energy_used_kwh: 6,
    wh_per_mi: 300,
    outside_temp_avg: 18,
    inside_temp_avg: 21,
    speed_max_mph: 70,
    power_max_kw: 120,
    power_min_kw: -40,
    ascent: 150,
    descent: 90,
    start_snapshot_id: null,
    end_snapshot_id: null,
    start_address_id: null,
    end_address_id: null,
    start_geofence_id: null,
    end_geofence_id: null,
    import_source: 'live',
    source_pk: null,
    route_geometry: null,
    route_match_status: null,
    route_matched_at: null,
    created_at: '2026-06-18T14:30:00Z',
    startLocation: 'Home',
    endLocation: 'Work',
    ...over,
  }
}

describe('buildIdles', () => {
  // Drives arrive newest-first. The idle is the gap between the EARLIER drive's
  // end and the LATER drive's start.
  const earlier = drive({ id: 1, ended_at: '2026-06-18T14:00:00Z', end_battery_level: 60, end_range_mi: 200, end_lat: 10, end_lng: 20, endLocation: 'Home' })
  const later = drive({ id: 2, started_at: '2026-06-18T15:00:00Z', start_battery_level: 58, start_range_mi: 199 })

  it('derives an idle window from two consecutive drives', () => {
    const [idle, ...rest] = buildIdles([later, earlier], { effWhPerMi: 250 })
    expect(rest).toHaveLength(0)
    expect(idle.prevDriveId).toBe(1)
    expect(idle.id).toBe('1')
    expect(idle.durMin).toBe(60)
    expect(idle.startBattery).toBe(60) // earlier drive's end
    expect(idle.endBattery).toBe(58) // later drive's start
    expect(idle.lat).toBe(10)
    expect(idle.lng).toBe(20)
    expect(idle.place).toBe('Home')
    expect(idle.title).toBe('Home')
  })

  it('estimates battery drain from rated-range drop × efficiency', () => {
    const [idle] = buildIdles([later, earlier], { effWhPerMi: 250 })
    // (200 - 199) mi × 250 Wh/mi = 250 Wh = 0.25 kWh
    expect(idle.batteryKwh).toBe(0.25)
    expect(idle.rangeUsedKm).toBeCloseTo(KM_PER_MI, 2)
  })

  it('falls back to SOC drop × pack when no efficiency is known', () => {
    const [idle] = buildIdles([later, earlier], { packKwh: 75 })
    // (60 - 58)% × 75 kWh = 1.5 kWh
    expect(idle.batteryKwh).toBe(1.5)
  })

  it('drops sub-minute gaps as poller jitter', () => {
    const near = drive({ id: 2, started_at: '2026-06-18T14:00:30Z' })
    expect(buildIdles([near, earlier])).toHaveLength(0)
  })

  it('keeps a brief but real idle above the jitter floor', () => {
    const brief = drive({ id: 2, started_at: '2026-06-18T14:08:00Z' })
    const [idle] = buildIdles([brief, earlier])
    expect(idle.durMin).toBe(8)
  })

  it('never pairs drives from different cars', () => {
    const otherCar = drive({ id: 2, vin: 'V2', started_at: '2026-06-18T15:00:00Z' })
    expect(buildIdles([otherCar, earlier])).toHaveLength(0)
  })

  it('pairs same-car drives across an interleaved other-car drive', () => {
    // newest-first: carA(later), carB(mid), carA(earlier).
    const aLater = drive({ id: 3, vin: 'A', started_at: '2026-06-18T18:00:00Z', start_battery_level: 50, start_range_mi: 180 })
    const bMid = drive({ id: 4, vin: 'B', started_at: '2026-06-18T16:00:00Z', ended_at: '2026-06-18T16:30:00Z' })
    const aEarlier = drive({ id: 5, vin: 'A', ended_at: '2026-06-18T14:00:00Z', end_battery_level: 55, end_range_mi: 200, endLocation: 'Home' })
    const idles = buildIdles([aLater, bMid, aEarlier])
    expect(idles).toHaveLength(1)
    expect(idles[0].prevDriveId).toBe(5)
    expect(idles[0].durMin).toBe(240) // 14:00 → 18:00, spanning carB's drive
  })

  it('does not borrow a SOC drop when a present rated range shows no drain', () => {
    // Range flat (200 → 200) but integer SOC ticked down 1% — range wins → no drain.
    const flatLater = drive({ id: 2, started_at: '2026-06-18T15:00:00Z', start_battery_level: 59, start_range_mi: 200 })
    const flatEarlier = drive({ id: 1, ended_at: '2026-06-18T14:00:00Z', end_battery_level: 60, end_range_mi: 200, endLocation: 'Home' })
    const [idle] = buildIdles([flatLater, flatEarlier], { effWhPerMi: 250, packKwh: 75 })
    expect(idle.batteryKwh).toBeNull()
    expect(idle.rangeUsedKm).toBeNull()
  })

  it('returns nothing for zero or one drive', () => {
    expect(buildIdles([])).toHaveLength(0)
    expect(buildIdles([earlier])).toHaveLength(0)
  })

  it('skips negative/overlapping windows', () => {
    const overlapping = drive({ id: 2, started_at: '2026-06-18T13:00:00Z' }) // before earlier.ended_at
    expect(buildIdles([overlapping, earlier])).toHaveLength(0)
  })
})

function sample(over: Partial<IdleSampleRaw> = {}): IdleSampleRaw {
  return { tMin: 0, soc: null, rangeMi: null, insideC: null, outsideC: null, powerKw: null, ...over }
}

function payload(over: Partial<IdleDetailPayload> = {}): IdleDetailPayload {
  return {
    found: true,
    prevDriveId: 1,
    vin: 'V1',
    startedAt: '2026-06-18T14:00:00Z',
    endedAt: '2026-06-18T15:00:00Z',
    place: 'Home',
    point: [10, 20],
    startBattery: 60,
    endBattery: 58,
    startRangeMi: 200,
    endRangeMi: 199,
    effWhPerMi: 250,
    packKwh: 75,
    chargerKwh: null,
    cost: null,
    states: [],
    samples: [],
    ...over,
  }
}

describe('buildIdleDetail', () => {
  it('returns a not-found VM for an empty payload', () => {
    const vm = buildIdleDetail(payload({ found: false, startedAt: null, endedAt: null }))
    expect(vm.found).toBe(false)
    expect(vm.series.soc).toHaveLength(0)
  })

  it('computes duration, energy and SOC delta', () => {
    const vm = buildIdleDetail(payload())
    expect(vm.found).toBe(true)
    expect(vm.durMin).toBe(60)
    expect(vm.batteryKwh).toBe(0.25)
    expect(vm.socDelta).toBe(-2)
    expect(vm.rangeUsedKm).toBeCloseTo(KM_PER_MI, 2)
  })

  it('rounds charger energy and cost', () => {
    const vm = buildIdleDetail(payload({ chargerKwh: 5.126, cost: { amount: 1.234, currency: 'USD' } }))
    expect(vm.chargerKwh).toBe(5.13)
    expect(vm.cost).toEqual({ amount: 1.23, currency: 'USD' })
  })

  it('builds chart series from samples (range converted to km)', () => {
    const vm = buildIdleDetail(
      payload({
        samples: [
          sample({ tMin: 0, soc: 60, rangeMi: 200, insideC: 25, outsideC: 29, powerKw: 0 }),
          sample({ tMin: 60, soc: 58, rangeMi: 199, insideC: 27, outsideC: 30, powerKw: 0 }),
        ],
      }),
    )
    expect(vm.series.soc).toEqual([{ x: 0, y: 60 }, { x: 60, y: 58 }])
    expect(vm.series.rangeKm[0].y).toBeCloseTo(200 * KM_PER_MI, 1)
    expect(vm.series.insideC).toHaveLength(2)
  })

  it('splits the window into time-in-state percentages', () => {
    const states: IdleStateSpan[] = [
      { state: 'asleep', started_at: '2026-06-18T14:00:00Z', ended_at: '2026-06-18T14:30:00Z' },
      { state: 'online', started_at: '2026-06-18T14:30:00Z', ended_at: '2026-06-18T15:00:00Z' },
    ]
    const vm = buildIdleDetail(payload({ states }))
    expect(vm.asleepPct).toBe(50)
    expect(vm.onlinePct).toBe(50)
  })

  it('clips state spans to the parked window', () => {
    // An asleep span that started before and ended after the window → 100% asleep.
    const states: IdleStateSpan[] = [
      { state: 'asleep', started_at: '2026-06-18T10:00:00Z', ended_at: '2026-06-18T20:00:00Z' },
    ]
    const vm = buildIdleDetail(payload({ states }))
    expect(vm.asleepPct).toBe(100)
  })

  it('reports null state percentages when there are no spans', () => {
    const vm = buildIdleDetail(payload({ states: [] }))
    expect(vm.asleepPct).toBeNull()
  })
})

describe('fmtIdleDuration', () => {
  it('formats minutes and hours', () => {
    expect(fmtIdleDuration(8)).toBe('8m')
    expect(fmtIdleDuration(60)).toBe('1h')
    expect(fmtIdleDuration(64)).toBe('1h 4m')
  })
})
