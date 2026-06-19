import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs sibling, no types
import { clusterSessions, mergeCluster, planMerges, receiptOf } from './merge.mjs'

const GAP_1MIN = 60_000

const s = (id, start, end, extra = {}) => ({
  id,
  source: 'home',
  started_at: start,
  ended_at: end,
  energy_added_kwh: null,
  energy_used_kwh: null,
  cost_amount: null,
  cost_currency: 'MYR',
  cost_source: 'computed',
  miles_added_rated: null,
  start_range_mi: null,
  end_range_mi: null,
  start_battery_level: null,
  end_battery_level: null,
  outside_temp_avg: null,
  geofence_id: null,
  rate_applied: null,
  invoices: null,
  ...extra,
})

const qc = (no) => ({ invoices: { quickcharge: { receiptNo: no } } })

describe('receiptOf', () => {
  it('pulls the quickcharge receipt number or null', () => {
    expect(receiptOf(s(1, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', qc('555')))).toBe('555')
    expect(receiptOf(s(1, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'))).toBeNull()
  })
})

describe('clusterSessions', () => {
  it('joins same-receipt sessions regardless of the gap between them', () => {
    // 3-min gap, but same receipt → one cluster (mirrors Apr 29 {10,11})
    const sessions = [
      s(10, '2026-04-29T14:05:00Z', '2026-04-29T14:08:00Z', qc('65518959')),
      s(11, '2026-04-29T14:11:00Z', '2026-04-29T22:31:00Z', qc('65518959')),
    ]
    const clusters = clusterSessions(sessions, GAP_1MIN)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].map((x) => x.id)).toEqual([10, 11])
  })

  it('does NOT merge non-receipt fragments beyond the gap window', () => {
    // Feb 19 {24,25}: 22-min gap, no receipts → two clusters at 1-min window
    const sessions = [
      s(24, '2026-02-19T13:14:00Z', '2026-02-19T13:26:00Z'),
      s(25, '2026-02-19T13:48:00Z', '2026-02-19T17:57:00Z'),
    ]
    expect(clusterSessions(sessions, GAP_1MIN)).toHaveLength(2)
  })

  it('merges near-back-to-back non-receipt fragments within the gap window', () => {
    const sessions = [
      s(1, '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'),
      s(2, '2026-01-01T00:30:30Z', '2026-01-01T01:00:00Z'), // 30s gap < 1min
    ]
    expect(clusterSessions(sessions, GAP_1MIN)).toHaveLength(1)
  })

  it('never merges two DIFFERENT receipts even if adjacent', () => {
    const sessions = [
      s(1, '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', qc('A')),
      s(2, '2026-01-01T00:30:10Z', '2026-01-01T01:00:00Z', qc('B')),
    ]
    expect(clusterSessions(sessions, GAP_1MIN)).toHaveLength(2)
  })

  it('keeps different sources apart', () => {
    const sessions = [
      s(1, '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'),
      { ...s(2, '2026-01-01T00:30:10Z', '2026-01-01T01:00:00Z'), source: 'supercharger' },
    ]
    expect(clusterSessions(sessions, GAP_1MIN)).toHaveLength(2)
  })
})

describe('mergeCluster', () => {
  it('merges the 3 May plug-in (id12/13/14) into one survivor with summed energy/cost', () => {
    const cluster = [
      s(12, '2026-05-03T04:54:00Z', '2026-05-03T07:36:00Z', {
        ...qc('13191709'), energy_added_kwh: 19.82, energy_used_kwh: 22.59, cost_amount: 22.5885,
        cost_source: 'quickcharge', start_battery_level: 49, end_battery_level: 82, start_range_mi: 131, end_range_mi: 217,
      }),
      s(13, '2026-05-03T07:37:00Z', '2026-05-03T08:31:00Z', {
        ...qc('13191709'), energy_added_kwh: 8.24, energy_used_kwh: 9.39, cost_amount: 9.391, cost_source: 'quickcharge',
      }),
      s(14, '2026-05-03T08:31:00Z', '2026-05-03T08:51:00Z', {
        ...qc('13191709'), energy_added_kwh: 2.08, energy_used_kwh: 2.37, cost_amount: 2.3705,
        cost_source: 'quickcharge', start_battery_level: 96, end_battery_level: 100, end_range_mi: 264,
      }),
    ]
    const { survivorId, absorbedIds, set } = mergeCluster(cluster)
    expect(survivorId).toBe(12)
    expect(absorbedIds).toEqual([13, 14])
    expect(set.started_at).toBeUndefined() // survivor keeps its own started_at (not patched)
    expect(set.ended_at).toBe('2026-05-03T08:51:00Z')
    expect(round4(set.energy_added_kwh)).toBe(30.14)
    expect(round4(set.energy_used_kwh)).toBe(34.35)
    expect(set.cost_amount).toBe(34.35) // = receipt #13191709 total
    expect(set.cost_source).toBe('quickcharge')
    expect(set.start_battery_level).toBe(49)
    expect(set.end_battery_level).toBe(100)
    expect(set.start_range_mi).toBe(131)
    expect(set.end_range_mi).toBe(264)
    expect(set.cost_currency).toBe('MYR')
  })

  it('prefers the authoritative cost_source when a cluster is mixed', () => {
    const cluster = [
      s(1, '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', { cost_source: 'computed', cost_amount: 5 }),
      s(2, '2026-01-01T00:30:10Z', '2026-01-01T01:00:00Z', { ...qc('X'), cost_source: 'quickcharge', cost_amount: 6 }),
    ]
    expect(mergeCluster(cluster).set.cost_source).toBe('quickcharge')
  })
})

describe('planMerges', () => {
  it('emits only multi-session clusters and is a no-op on already-merged singletons', () => {
    const merged = [s(1, '2026-01-01T00:00:00Z', '2026-01-01T05:00:00Z', { ...qc('A'), energy_added_kwh: 40 })]
    expect(planMerges(merged, GAP_1MIN)).toHaveLength(0)
  })
})

function round4(n: number | null) {
  return n == null ? null : Math.round(n * 10000) / 10000
}
