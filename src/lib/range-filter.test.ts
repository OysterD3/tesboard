import { describe, expect, it } from 'vitest'
import {
  ALL_TIME,
  clampCustom,
  filterByRange,
  inRangeMs,
  inResolvedRange,
  lastChargeMsOf,
  rangeLabel,
  rangeToIso,
  resolveRange,
  toYmdUtc,
} from './range-filter'

const DAY = 86_400_000
// Fixed anchor so nothing depends on the wall clock: 2026-06-20T12:00:00Z (a Saturday)
const NOW = Date.parse('2026-06-20T12:00:00.000Z')

describe('resolveRange', () => {
  it('7d / 30d count back from now', () => {
    expect(resolveRange({ key: '7d' }, NOW)).toEqual({ fromMs: NOW - 7 * DAY, toMs: NOW })
    expect(resolveRange({ key: '30d' }, NOW)).toEqual({ fromMs: NOW - 30 * DAY, toMs: NOW })
  })

  it('today is the UTC calendar day up to now', () => {
    expect(resolveRange({ key: 'today' }, NOW)).toEqual({
      fromMs: Date.parse('2026-06-20T00:00:00.000Z'),
      toMs: NOW,
    })
  })

  it('yesterday is the full previous UTC day', () => {
    expect(resolveRange({ key: 'yesterday' }, NOW)).toEqual({
      fromMs: Date.parse('2026-06-19T00:00:00.000Z'),
      toMs: Date.parse('2026-06-20T00:00:00.000Z') - 1,
    })
  })

  it('thisYear runs from Jan 1 UTC to now', () => {
    expect(resolveRange({ key: 'thisYear' }, NOW)).toEqual({
      fromMs: Date.parse('2026-01-01T00:00:00.000Z'),
      toMs: NOW,
    })
  })

  it('lastYear is the whole previous calendar year (UTC)', () => {
    expect(resolveRange({ key: 'lastYear' }, NOW)).toEqual({
      fromMs: Date.parse('2025-01-01T00:00:00.000Z'),
      toMs: Date.parse('2026-01-01T00:00:00.000Z') - 1,
    })
  })

  it('sinceLastCharge runs from the last charge to now, or all-time when none', () => {
    const last = Date.parse('2026-06-18T08:00:00Z')
    expect(resolveRange({ key: 'sinceLastCharge' }, NOW, last)).toEqual({ fromMs: last, toMs: NOW })
    expect(resolveRange({ key: 'sinceLastCharge' }, NOW, null)).toEqual(ALL_TIME)
  })

  it('all is unbounded', () => {
    expect(resolveRange({ key: 'all' }, NOW)).toEqual(ALL_TIME)
  })

  it('custom resolves to UTC day bounds and orders a reversed pair', () => {
    const r = resolveRange({ key: 'custom', customFrom: '2026-06-10', customTo: '2026-06-01' }, NOW)
    expect(r.fromMs).toBe(Date.parse('2026-06-01T00:00:00.000Z'))
    expect(r.toMs).toBe(Date.parse('2026-06-10T23:59:59.999Z'))
  })

  it('custom allows spans wider than 60 days (no client cap)', () => {
    const r = resolveRange({ key: 'custom', customFrom: '2026-01-01', customTo: '2026-06-10' }, NOW)
    expect((r.toMs! - r.fromMs!) / DAY).toBeGreaterThan(150)
  })

  it('incomplete custom falls back to all-time', () => {
    expect(resolveRange({ key: 'custom', customFrom: '2026-06-01' }, NOW)).toEqual(ALL_TIME)
  })
})

describe('clampCustom', () => {
  it('orders a reversed pair without capping the span', () => {
    expect(clampCustom('2026-06-10', '2026-06-01')).toEqual({ from: '2026-06-01', to: '2026-06-10' })
    expect(clampCustom('2026-01-01', '2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('leaves unparseable input untouched', () => {
    expect(clampCustom('nope', '2026-06-10')).toEqual({ from: 'nope', to: '2026-06-10' })
  })
})

describe('inRangeMs / inResolvedRange', () => {
  const r = { fromMs: Date.parse('2026-06-01T00:00:00Z'), toMs: Date.parse('2026-06-10T23:59:59.999Z') }

  it('includes the bounds and excludes outside', () => {
    expect(inResolvedRange('2026-06-01T00:00:00Z', r)).toBe(true)
    expect(inResolvedRange('2026-05-31T23:59:59Z', r)).toBe(false)
    expect(inResolvedRange('2026-06-11T00:00:00Z', r)).toBe(false)
  })

  it('all-time admits everything; bad timestamps excluded when bounded', () => {
    expect(inResolvedRange('not-a-date', ALL_TIME)).toBe(true)
    expect(inResolvedRange('not-a-date', r)).toBe(false)
    expect(inRangeMs(NaN, r)).toBe(false)
    expect(inRangeMs(Date.parse('2026-06-05T00:00:00Z'), r)).toBe(true)
  })
})

describe('filterByRange', () => {
  const rows = [
    { started_at: '2026-06-01T10:00:00Z', id: 'a' },
    { started_at: '2026-06-15T10:00:00Z', id: 'b' },
    { started_at: '2026-06-19T10:00:00Z', id: 'c' },
  ]

  it('returns the same array reference for all-time (no copy)', () => {
    expect(filterByRange(rows, ALL_TIME)).toBe(rows)
  })

  it('keeps only in-window rows', () => {
    const r = resolveRange({ key: '7d' }, NOW) // 2026-06-13 .. 2026-06-20
    expect(filterByRange(rows, r).map((x) => x.id)).toEqual(['b', 'c'])
  })
})

describe('lastChargeMsOf', () => {
  it('picks the latest ended_at, falling back to started_at', () => {
    const sessions = [
      { started_at: '2026-06-01T00:00:00Z', ended_at: '2026-06-01T01:00:00Z' },
      { started_at: '2026-06-18T07:00:00Z', ended_at: null },
      { started_at: '2026-06-10T00:00:00Z', ended_at: '2026-06-10T02:00:00Z' },
    ]
    expect(lastChargeMsOf(sessions)).toBe(Date.parse('2026-06-18T07:00:00Z'))
  })

  it('returns null for no sessions', () => {
    expect(lastChargeMsOf([])).toBeNull()
  })
})

describe('rangeLabel / rangeToIso / toYmdUtc', () => {
  it('labels each key', () => {
    expect(rangeLabel({ key: 'today' })).toBe('Today')
    expect(rangeLabel({ key: 'yesterday' })).toBe('Yesterday')
    expect(rangeLabel({ key: '7d' })).toBe('Last 7 days')
    expect(rangeLabel({ key: 'thisYear' })).toBe('This year')
    expect(rangeLabel({ key: 'lastYear' })).toBe('Last year')
    expect(rangeLabel({ key: 'sinceLastCharge' })).toBe('Since last charge')
    expect(rangeLabel({ key: 'all' })).toBe('All time')
    expect(rangeLabel({ key: 'custom', customFrom: '2026-06-01', customTo: '2026-06-10' })).toBe('Jun 1 – Jun 10')
  })

  it('rangeToIso emits null for open sides', () => {
    expect(rangeToIso(ALL_TIME)).toEqual({ from: null, to: null })
    const iso = rangeToIso(resolveRange({ key: '7d' }, NOW))
    expect(iso.from).toBe(new Date(NOW - 7 * DAY).toISOString())
    expect(iso.to).toBe(new Date(NOW).toISOString())
  })

  it('toYmdUtc formats in UTC', () => {
    expect(toYmdUtc(Date.parse('2026-06-20T23:30:00Z'))).toBe('2026-06-20')
  })
})
