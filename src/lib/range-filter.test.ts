import { describe, expect, it } from 'vitest'
import {
  ALL_TIME,
  MAX_CUSTOM_DAYS,
  clampCustom,
  clampServerWindow,
  filterByRange,
  inResolvedRange,
  rangeLabel,
  rangeToIso,
  resolveRange,
  toYmdUtc,
} from './range-filter'

const DAY = 86_400_000
// Fixed anchor so nothing depends on the wall clock: 2026-06-20T12:00:00Z
const NOW = Date.parse('2026-06-20T12:00:00.000Z')

describe('resolveRange', () => {
  it('7d window is exactly 7 days back from now, inclusive of now', () => {
    expect(resolveRange({ key: '7d' }, NOW)).toEqual({ fromMs: NOW - 7 * DAY, toMs: NOW })
  })

  it('30d window is exactly 30 days back from now', () => {
    expect(resolveRange({ key: '30d' }, NOW)).toEqual({ fromMs: NOW - 30 * DAY, toMs: NOW })
  })

  it('all is unbounded on both sides', () => {
    expect(resolveRange({ key: 'all' }, NOW)).toEqual(ALL_TIME)
  })

  it('custom resolves to UTC day bounds (start-of-day .. end-of-day)', () => {
    const r = resolveRange({ key: 'custom', customFrom: '2026-06-01', customTo: '2026-06-10' }, NOW)
    expect(r.fromMs).toBe(Date.parse('2026-06-01T00:00:00.000Z'))
    expect(r.toMs).toBe(Date.parse('2026-06-10T23:59:59.999Z'))
  })

  it('custom spanning more than 60 days is clamped (start pulled forward)', () => {
    const r = resolveRange({ key: 'custom', customFrom: '2026-01-01', customTo: '2026-06-10' }, NOW)
    const span = (r.toMs! - r.fromMs!) / DAY
    // end-of-day .. start-of-day ⇒ ~MAX_CUSTOM_DAYS + ~1 day of intra-day slack
    expect(span).toBeGreaterThan(MAX_CUSTOM_DAYS)
    expect(span).toBeLessThan(MAX_CUSTOM_DAYS + 1)
  })

  it('incomplete custom falls back to all-time', () => {
    expect(resolveRange({ key: 'custom', customFrom: '2026-06-01' }, NOW)).toEqual(ALL_TIME)
    expect(resolveRange({ key: 'custom' }, NOW)).toEqual(ALL_TIME)
  })
})

describe('clampCustom', () => {
  it('orders a reversed pair', () => {
    expect(clampCustom('2026-06-10', '2026-06-01')).toEqual({ from: '2026-06-01', to: '2026-06-10' })
  })

  it('caps the span at MAX_CUSTOM_DAYS', () => {
    const { from, to } = clampCustom('2026-01-01', '2026-06-10')
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY
    expect(span).toBe(MAX_CUSTOM_DAYS)
    expect(to).toBe('2026-06-10')
  })

  it('leaves unparseable input untouched', () => {
    expect(clampCustom('nope', '2026-06-10')).toEqual({ from: 'nope', to: '2026-06-10' })
  })
})

describe('inResolvedRange', () => {
  const r = { fromMs: Date.parse('2026-06-01T00:00:00Z'), toMs: Date.parse('2026-06-10T23:59:59.999Z') }

  it('includes the bounds and excludes outside', () => {
    expect(inResolvedRange('2026-06-01T00:00:00Z', r)).toBe(true)
    expect(inResolvedRange('2026-06-05T08:00:00Z', r)).toBe(true)
    expect(inResolvedRange('2026-05-31T23:59:59Z', r)).toBe(false)
    expect(inResolvedRange('2026-06-11T00:00:00Z', r)).toBe(false)
  })

  it('all-time admits everything, and bad timestamps are excluded when bounded', () => {
    expect(inResolvedRange('not-a-date', ALL_TIME)).toBe(true)
    expect(inResolvedRange('not-a-date', r)).toBe(false)
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

describe('clampServerWindow', () => {
  it('passes a within-cap window through unchanged', () => {
    const w = clampServerWindow('2026-06-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z')
    expect(w).toEqual({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-10T00:00:00.000Z' })
  })

  it('caps an over-wide window by pulling `from` forward (defeats unbounded-scan abuse)', () => {
    const w = clampServerWindow('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z')!
    const span = (Date.parse(w.to) - Date.parse(w.from)) / DAY
    expect(span).toBe(MAX_CUSTOM_DAYS)
    expect(w.to).toBe('2100-01-01T00:00:00.000Z') // end preserved, start clamped
  })

  it('missing `to` caps the span to MAX_CUSTOM_DAYS forward of `from`', () => {
    const w = clampServerWindow('2026-06-01T00:00:00.000Z', null)!
    expect((Date.parse(w.to) - Date.parse(w.from)) / DAY).toBe(MAX_CUSTOM_DAYS)
  })

  it('returns null for an unparseable `from` (caller falls back to all-time)', () => {
    expect(clampServerWindow('garbage', '2026-06-10T00:00:00.000Z')).toBeNull()
  })
})

describe('rangeLabel / rangeToIso / toYmdUtc', () => {
  it('labels each key', () => {
    expect(rangeLabel({ key: '7d' })).toBe('Last 7 days')
    expect(rangeLabel({ key: '30d' })).toBe('Last 30 days')
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
