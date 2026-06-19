import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs sibling, no types
import {
  distribute,
  durationS,
  localClockToUtcIso,
  localDateOf,
  reconcile,
  round,
} from './reconcile.mjs'

const OFFSET = 480 // Malaysia, UTC+8

describe('localDateOf', () => {
  it('shifts UTC into local before taking the calendar date', () => {
    expect(localDateOf('2026-04-11T05:03:00Z', OFFSET)).toBe('2026-04-11') // 13:03 local
    expect(localDateOf('2026-04-10T17:00:00Z', OFFSET)).toBe('2026-04-11') // 01:00 local next day
    expect(localDateOf('2026-04-11T16:30:00Z', OFFSET)).toBe('2026-04-12') // 00:30 local next day
  })
  it('returns null on garbage', () => {
    expect(localDateOf('nope', OFFSET)).toBeNull()
  })
})

describe('localClockToUtcIso', () => {
  it('maps local noon back to the right UTC instant', () => {
    // local noon at +8 = 04:00Z same day
    expect(localClockToUtcIso('2026-04-11', 12, OFFSET)).toBe('2026-04-11T04:00:00Z')
  })
  it('round-trips with localDateOf', () => {
    const iso = localClockToUtcIso('2026-06-09', 12, OFFSET)
    expect(localDateOf(iso, OFFSET)).toBe('2026-06-09')
  })
})

describe('durationS', () => {
  it('computes seconds and clamps negatives to 0', () => {
    expect(durationS('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')).toBe(3600)
    expect(durationS('2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z')).toBe(0)
    expect(durationS('2026-01-01T00:00:00Z', null)).toBeNull()
  })
})

describe('distribute', () => {
  it('splits proportionally and sums EXACTLY to the total', () => {
    const total = 39.5
    const weights = [5.86, 7, 4.62, 5.88, 1, 11.74]
    const out = distribute(total, weights, 4)
    expect(round(out.reduce((a, b) => a + b, 0), 4)).toBe(total)
    // each share is positive and ordered roughly by weight
    expect(out.every((x) => x > 0)).toBe(true)
    expect(out[5]).toBeGreaterThan(out[4]) // 11.74 weight > 1 weight
  })
  it('handles a single weight (whole total on it)', () => {
    expect(distribute(42.62, [41.48], 4)).toEqual([42.62])
  })
  it('gives zero to zero/negative weights', () => {
    const out = distribute(10, [0, 5, 0, 5], 4)
    expect(out[0]).toBe(0)
    expect(out[2]).toBe(0)
    expect(round(out.reduce((a, b) => a + b, 0), 4)).toBe(10)
  })
  it('returns all zeros when no positive weight', () => {
    expect(distribute(10, [0, 0], 4)).toEqual([0, 0])
  })
})

const geofence = { id: 1, is_home: false }

describe('reconcile', () => {
  it('distributes one receipt across split same-day sessions', () => {
    const receipts = [{ receiptNo: '80243595', date: '2026-04-11', charger: '8wuwc1', spent: 39.5, usageKwh: 39.502 }]
    const sessions = [
      { id: 37, started_at: '2026-04-11T05:03:00Z', ended_at: '2026-04-11T05:45:00Z', energy_added_kwh: 5.86, cost_source: 'geofence' },
      { id: 38, started_at: '2026-04-11T05:45:00Z', ended_at: '2026-04-11T06:36:00Z', energy_added_kwh: 7.0, cost_source: 'geofence' },
      { id: 39, started_at: '2026-04-11T06:36:00Z', ended_at: '2026-04-11T07:09:00Z', energy_added_kwh: 4.62, cost_source: 'geofence' },
      { id: 40, started_at: '2026-04-11T07:09:00Z', ended_at: '2026-04-11T07:51:00Z', energy_added_kwh: 5.88, cost_source: 'geofence' },
      { id: 41, started_at: '2026-04-11T07:51:00Z', ended_at: '2026-04-11T07:58:00Z', energy_added_kwh: 1.0, cost_source: 'geofence' },
      { id: 42, started_at: '2026-04-11T07:58:00Z', ended_at: '2026-04-11T09:23:00Z', energy_added_kwh: 11.74, cost_source: 'geofence' },
    ]
    const { applies, inserts, review, excluded } = reconcile({ receipts, sessions, offsetMin: OFFSET, geofence })
    expect(inserts).toHaveLength(0)
    expect(review).toHaveLength(0)
    expect(excluded).toHaveLength(0)
    expect(applies).toHaveLength(6)
    // cost shares sum to the receipt total
    expect(round(applies.reduce((a, x) => a + x.cost_amount, 0), 4)).toBe(39.5)
    // grid energy shares sum to the receipt usage
    expect(round(applies.reduce((a, x) => a + x.energy_used_kwh, 0), 4)).toBe(39.502)
    expect(applies.every((a) => a.geofence_id === 1 && a.receiptNo === '80243595')).toBe(true)
  })

  it('matches 1:1 when a receipt has a single session that day', () => {
    const receipts = [{ receiptNo: '85333111', date: '2026-04-24', charger: '8wuwc1', spent: 42.62, usageKwh: 42.617 }]
    const sessions = [
      { id: 9, started_at: '2026-04-24T11:16:00Z', ended_at: '2026-04-24T15:23:00Z', energy_added_kwh: 41.48, cost_source: 'imported_teslamate' },
    ]
    const { applies, review } = reconcile({ receipts, sessions, offsetMin: OFFSET, geofence })
    expect(review).toHaveLength(0)
    expect(applies).toHaveLength(1)
    expect(applies[0]).toMatchObject({ id: 9, cost_amount: 42.62, energy_used_kwh: 42.617 })
  })

  it('inserts a standalone gap row when no session matches', () => {
    const receipts = [{ receiptNo: '83071720', date: '2026-06-09', charger: 'bnrzvw', spent: 41.04, usageKwh: 41.039 }]
    const { applies, inserts } = reconcile({ receipts, sessions: [], offsetMin: OFFSET, geofence })
    expect(applies).toHaveLength(0)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      receiptNo: '83071720',
      cost_amount: 41.04,
      energy_used_kwh: 41.039,
      energy_added_kwh: null,
      geofence_id: 1,
      charge_location_type: 'away',
      duration_estimated: true,
    })
    expect(localDateOf(inserts[0].started_at, OFFSET)).toBe('2026-06-09')
    // ended_at after started_at (estimated from energy at ~7 kW)
    expect(Date.parse(inserts[0].ended_at)).toBeGreaterThan(Date.parse(inserts[0].started_at))
  })

  it('excludes a corrupt multi-day session and reviews the leftover ratio', () => {
    const receipts = [{ receiptNo: '13191709', date: '2026-05-03', charger: '8wuwc1', spent: 34.35, usageKwh: 34.346 }]
    const sessions = [
      { id: 12, started_at: '2026-05-03T04:54:00Z', ended_at: '2026-05-03T07:36:00Z', energy_added_kwh: 19.82, cost_source: 'imported_teslamate' },
      { id: 14, started_at: '2026-05-03T08:31:00Z', ended_at: '2026-05-03T08:51:00Z', energy_added_kwh: 2.08, cost_source: 'imported_teslamate' },
      // the corrupt 42-day unclosed session
      { id: 13, started_at: '2026-05-03T07:37:00Z', ended_at: '2026-06-14T12:04:00Z', energy_added_kwh: 150.54, cost_source: 'geofence' },
    ]
    const { applies, excluded, review } = reconcile({ receipts, sessions, offsetMin: OFFSET, geofence })
    // id 13 dropped for both reasons; reported once (first matching guard = duration)
    expect(excluded.some((e) => e.id === 13)).toBe(true)
    // leftover battery (21.9) vs receipt grid (34.3) → ratio 1.57 > 1.4 → review, no apply
    expect(applies).toHaveLength(0)
    expect(review).toHaveLength(1)
    expect(review[0].sessionIds).toEqual([12, 14])
  })

  it('routes two receipts on the same local date to review (cannot auto-attribute)', () => {
    const receipts = [
      { receiptNo: 'A', date: '2026-04-11', charger: '8wuwc1', spent: 20.0, usageKwh: 20.0 },
      { receiptNo: 'B', date: '2026-04-11', charger: 'bnrzvw', spent: 19.5, usageKwh: 19.5 },
    ]
    const sessions = [
      { id: 37, started_at: '2026-04-11T05:03:00Z', ended_at: '2026-04-11T05:45:00Z', energy_added_kwh: 18, cost_source: 'geofence' },
      { id: 42, started_at: '2026-04-11T07:58:00Z', ended_at: '2026-04-11T09:23:00Z', energy_added_kwh: 18, cost_source: 'geofence' },
    ]
    const { applies, review, unmatchedSessions } = reconcile({ receipts, sessions, offsetMin: OFFSET, geofence })
    // neither receipt is auto-applied; both flagged; sessions left for manual resolution
    expect(applies).toHaveLength(0)
    expect(review.map((r) => r.receiptNo).sort()).toEqual(['A', 'B'])
    expect(unmatchedSessions.map((u) => u.id).sort()).toEqual([37, 42])
  })

  it('does not double-claim a session and reports the unclaimed ones', () => {
    const receipts = [{ receiptNo: 'A', date: '2026-05-23', charger: 'bnrzvw', spent: 45.72, usageKwh: 45.718 }]
    const sessions = [
      { id: 20, started_at: '2026-05-23T11:21:00Z', ended_at: '2026-05-23T15:45:00Z', energy_added_kwh: 42.42, cost_source: 'imported_teslamate' },
      { id: 99, started_at: '2026-05-30T10:00:00Z', ended_at: '2026-05-30T11:00:00Z', energy_added_kwh: 5, cost_source: 'computed' },
    ]
    const { applies, unmatchedSessions } = reconcile({ receipts, sessions, offsetMin: OFFSET, geofence })
    expect(applies.map((a) => a.id)).toEqual([20])
    expect(unmatchedSessions.map((u) => u.id)).toEqual([99])
  })
})
