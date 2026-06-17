import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs sibling, no types
import {
  classifyChargeLocation,
  clamp,
  computeChargeCost,
  derivePackKwh,
  deriveEfficiencyWhPerMi,
  deriveStates,
  findGeofence,
  firstNonNull,
  haversineMeters,
  lastNonNull,
  maxNonNull,
  avgNonNull,
  msToIso,
  num,
  parseCsv,
  positiveDelta,
  sessionizeRuns,
  socEnergyKwh,
  tessieTsToIso,
  tessieTsToMs,
  toBool,
  toInt,
  whPerMi,
} from './convert.mjs'

describe('parseCsv', () => {
  it('parses quoted fields and bare empty cells', () => {
    const text =
      'Timestamp (UTC),Charging State,Usable Battery Level (%),Ideal Battery Range (mi)\n' +
      '"2026-02-15 09:56:14","Disconnected","80",\n' +
      '"2026-02-15 09:56:25","Charging","71","190.45"\n'
    const { header, rows } = parseCsv(text)
    expect(header[0]).toBe('Timestamp (UTC)')
    expect(header).toHaveLength(4)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(['2026-02-15 09:56:14', 'Disconnected', '80', ''])
    expect(rows[1][3]).toBe('190.45')
  })

  it('handles a trailing newline without emitting a blank row', () => {
    const { rows } = parseCsv('a,b\n"1","2"\n')
    expect(rows).toHaveLength(1)
  })

  it('handles escaped quotes and CRLF', () => {
    const { rows } = parseCsv('a\r\n"he said ""hi"""\r\n')
    expect(rows[0][0]).toBe('he said "hi"')
  })
})

describe('cell coercion', () => {
  it('num: empty → null, finite → number', () => {
    expect(num('')).toBeNull()
    expect(num(null)).toBeNull()
    expect(num('146.98474')).toBeCloseTo(146.98474)
    expect(num('NaNish')).toBeNull()
  })
  it('toInt rounds', () => {
    expect(toInt('241')).toBe(241)
    expect(toInt('16.6')).toBe(17)
    expect(toInt('')).toBeNull()
  })
  it('toBool maps 1/0', () => {
    expect(toBool('1')).toBe(true)
    expect(toBool('0')).toBe(false)
    expect(toBool('')).toBeNull()
  })
})

describe('Tessie timestamps', () => {
  it('converts to ISO Z', () => {
    expect(tessieTsToIso('2026-02-15 09:56:14')).toBe('2026-02-15T09:56:14Z')
    expect(tessieTsToIso('')).toBeNull()
  })
  it('converts to ms and round-trips via msToIso', () => {
    const ms = tessieTsToMs('2026-02-15 09:56:14')
    expect(ms).toBe(Date.UTC(2026, 1, 15, 9, 56, 14))
    expect(msToIso(ms)).toBe('2026-02-15T09:56:14Z')
  })
})

describe('sessionizeRuns', () => {
  const mk = (defs) => defs.map(([ms, active]) => ({ ms, active }))
  const isActive = (s) => s.active
  const MIN = 60_000

  it('opens at first active, closes at first inactive (ended_at = close sample)', () => {
    // active 0..2min, inactive at 3min
    const s = mk([
      [0, true],
      [1 * MIN, true],
      [2 * MIN, true],
      [3 * MIN, false],
    ])
    const runs = sessionizeRuns(s, isActive, 6 * 60 * MIN)
    expect(runs).toHaveLength(1)
    expect(runs[0].startMs).toBe(0)
    expect(runs[0].endMs).toBe(2 * MIN) // last active
    expect(runs[0].closeMs).toBe(3 * MIN) // first inactive
  })

  it('stale-closes at last active when stream ends active', () => {
    const s = mk([
      [0, true],
      [1 * MIN, true],
    ])
    const runs = sessionizeRuns(s, isActive, 6 * 60 * MIN)
    expect(runs[0].closeMs).toBe(1 * MIN)
  })

  it('splits a run on an internal gap larger than maxGapMs', () => {
    const s = mk([
      [0, true],
      [1 * MIN, true],
      [600 * MIN, true], // 10h gap > 6h
      [601 * MIN, true],
    ])
    const runs = sessionizeRuns(s, isActive, 6 * 60 * MIN)
    expect(runs).toHaveLength(2)
    expect(runs[0].closeMs).toBe(1 * MIN)
    expect(runs[1].startMs).toBe(600 * MIN)
  })

  it('produces two sessions separated by an inactive stretch', () => {
    const s = mk([
      [0, true],
      [1 * MIN, false],
      [2 * MIN, true],
      [3 * MIN, false],
    ])
    const runs = sessionizeRuns(s, isActive, 6 * 60 * MIN)
    expect(runs).toHaveLength(2)
  })
})

describe('aggregation primitives', () => {
  it('first/last/avg/max non-null', () => {
    const v = [null, 2, null, 4, 6, null]
    expect(firstNonNull(v)).toBe(2)
    expect(lastNonNull(v)).toBe(6)
    expect(avgNonNull(v)).toBe(4)
    expect(maxNonNull(v)).toBe(6)
    expect(firstNonNull([null, null])).toBeNull()
    expect(avgNonNull([null])).toBeNull()
  })
  it('positiveDelta only when a−b > 0', () => {
    expect(positiveDelta(60, 50)).toBe(10)
    expect(positiveDelta(50, 60)).toBeNull()
    expect(positiveDelta(null, 1)).toBeNull()
  })
  it('clamp bounds', () => {
    expect(clamp(80, 0, 63)).toBe(63)
    expect(clamp(-1, 0, 63)).toBe(0)
    expect(clamp(null, 0, 63)).toBeNull()
  })
})

describe('energy + efficiency', () => {
  it('whPerMi guards sub-mile and non-positive energy', () => {
    expect(whPerMi(10, 40)).toBe(250)
    expect(whPerMi(10, 0.5)).toBeNull()
    expect(whPerMi(0, 40)).toBeNull()
  })
  it('socEnergyKwh = SOC delta × pack, clamps net charge to null', () => {
    expect(socEnergyKwh(80, 60, 63)).toBeCloseTo((20 / 100) * 63)
    expect(socEnergyKwh(60, 80, 63)).toBeNull()
  })
  it('derivePackKwh medians the stable SOC band', () => {
    const pairs = [
      { socPct: 80, remainingKwh: 50.6 },
      { socPct: 56, remainingKwh: 35.4 },
      { socPct: 95, remainingKwh: 60 }, // excluded (>90)
      { socPct: 10, remainingKwh: 6 }, // excluded (<25)
    ]
    const pack = derivePackKwh(pairs)
    expect(pack).toBeGreaterThan(62)
    expect(pack).toBeLessThan(64)
  })
  it('deriveEfficiencyWhPerMi returns the modal Wh/mi', () => {
    // factor 0.25 kWh/mi appears most often → 250 Wh/mi
    const samples = [
      { energyKwh: 10, rangeAddedMi: 40 },
      { energyKwh: 5, rangeAddedMi: 20 },
      { energyKwh: 2.5, rangeAddedMi: 10 },
      { energyKwh: 9, rangeAddedMi: 30 }, // 0.30 outlier
    ]
    expect(deriveEfficiencyWhPerMi(samples)).toBeCloseTo(250, 0)
    expect(deriveEfficiencyWhPerMi([])).toBeNull()
  })
})

describe('geo', () => {
  it('haversine is ~0 for identical points and ~111km per degree lat', () => {
    expect(haversineMeters(3.2, 101.6, 3.2, 101.6)).toBeCloseTo(0)
    expect(haversineMeters(0, 0, 1, 0)).toBeGreaterThan(110_000)
  })
  it('findGeofence picks nearest containing zone', () => {
    const zones = [
      { id: 1, lat: 3.209, lng: 101.6687, radius_m: 150 },
      { id: 2, lat: 3.5, lng: 101.9, radius_m: 150 },
    ]
    expect(findGeofence(3.2091, 101.66875, zones)?.id).toBe(1)
    expect(findGeofence(10, 10, zones)).toBeNull()
  })
  it('classifyChargeLocation: SC wins, then home radius', () => {
    expect(classifyChargeLocation('supercharger', null, null, null)).toBe('supercharger')
    const home = { home_lat: 3.209, home_lng: 101.6687, home_radius_m: 150 }
    expect(classifyChargeLocation('home', 3.2091, 101.66875, home)).toBe('home')
    expect(classifyChargeLocation('home', 3.5, 101.9, home)).toBe('away')
    expect(classifyChargeLocation('home', 3.2, 101.6, null)).toBe('unknown')
  })
})

describe('computeChargeCost', () => {
  it('free supercharger → 0 / tesla_billed_free', () => {
    const r = computeChargeCost({ source: 'supercharger', freeSupercharging: true, energyAddedKwh: 30 })
    expect(r.cost_amount).toBe(0)
    expect(r.cost_source).toBe('tesla_billed_free')
  })
  it('paid supercharger → null (reconcile fills later)', () => {
    const r = computeChargeCost({ source: 'supercharger', energyAddedKwh: 30 })
    expect(r.cost_amount).toBeNull()
  })
  it('home flat rate = energy × rate × loss', () => {
    const r = computeChargeCost({
      source: 'home',
      isHome: true,
      energyAddedKwh: 10,
      homeRate: { flat_rate: 0.2, loss_factor: 1.1, currency: 'MYR' },
    })
    expect(r.cost_amount).toBeCloseTo(10 * 0.2 * 1.1)
    expect(r.cost_currency).toBe('MYR')
    expect(r.cost_source).toBe('computed')
  })
  it('geofence per_kwh = max(used,added) × rate + fee', () => {
    const r = computeChargeCost({
      source: 'home',
      energyAddedKwh: 10,
      energyUsedKwh: 11,
      geofence: { billing_type: 'per_kwh', cost_per_unit: 0.3, session_fee: 1, currency: 'MYR', is_home: false },
    })
    expect(r.cost_amount).toBeCloseTo(11 * 0.3 + 1)
    expect(r.cost_source).toBe('geofence')
  })
})

describe('deriveStates', () => {
  const MIN = 60_000
  it('infers asleep from a gap, driving/charging from classify, else online', () => {
    const ms = [0, 1 * MIN, 2 * MIN, 60 * MIN, 61 * MIN]
    const classify = (m) => (m === 1 * MIN ? 'driving' : null)
    const intervals = deriveStates(ms, classify, 20 * MIN)
    // 0→1 online, 1→2 driving, 2→60 asleep (gap 58m>20m), 60→61 online
    expect(intervals.map((i) => i.state)).toEqual(['online', 'driving', 'asleep', 'online'])
  })
  it('merges adjacent equal states', () => {
    const ms = [0, 1 * MIN, 2 * MIN, 3 * MIN]
    const intervals = deriveStates(ms, () => null, 20 * MIN)
    expect(intervals).toHaveLength(1)
    expect(intervals[0]).toMatchObject({ state: 'online', startMs: 0, endMs: 3 * MIN })
  })
})
