import { describe, expect, it } from 'vitest'
import { clusterSessions, mergeCluster, planMerges, receiptOf, type MergeSession } from './charge-merge'

const GAP = 60_000

const base: MergeSession = {
  id: 0,
  user_id: 'u1',
  vin: 'VIN1',
  source: 'home',
  started_at: '2026-01-01T00:00:00Z',
  ended_at: '2026-01-01T01:00:00Z',
  energy_added_kwh: null,
  energy_used_kwh: null,
  cost_amount: null,
  cost_currency: 'MYR',
  cost_source: 'computed',
  rate_applied: null,
  miles_added_rated: null,
  start_range_mi: null,
  end_range_mi: null,
  start_battery_level: null,
  end_battery_level: null,
  outside_temp_avg: null,
  geofence_id: null,
  invoices: null,
}
const mk = (o: Partial<MergeSession>): MergeSession => ({ ...base, ...o })
const qc = (no: string) => ({ invoices: { quickcharge: { receiptNo: no } } })

describe('receiptOf', () => {
  it('reads the quickcharge receipt or null', () => {
    expect(receiptOf(mk(qc('99')))).toBe('99')
    expect(receiptOf(mk({}))).toBeNull()
  })
})

describe('clusterSessions', () => {
  it('joins same-receipt sessions across a 3-min gap', () => {
    const c = clusterSessions(
      [
        mk({ id: 10, started_at: '2026-04-29T14:05:00Z', ended_at: '2026-04-29T14:08:00Z', ...qc('R') }),
        mk({ id: 11, started_at: '2026-04-29T14:11:00Z', ended_at: '2026-04-29T22:31:00Z', ...qc('R') }),
      ],
      GAP,
    )
    expect(c).toHaveLength(1)
  })
  it('splits non-receipt fragments past the gap window, joins within it', () => {
    expect(
      clusterSessions(
        [
          mk({ id: 1, started_at: '2026-02-19T13:14:00Z', ended_at: '2026-02-19T13:26:00Z' }),
          mk({ id: 2, started_at: '2026-02-19T13:48:00Z', ended_at: '2026-02-19T17:57:00Z' }),
        ],
        GAP,
      ),
    ).toHaveLength(2)
    expect(
      clusterSessions(
        [
          mk({ id: 1, started_at: '2026-02-19T13:14:00Z', ended_at: '2026-02-19T13:26:00Z' }),
          mk({ id: 2, started_at: '2026-02-19T13:26:30Z', ended_at: '2026-02-19T17:57:00Z' }),
        ],
        GAP,
      ),
    ).toHaveLength(1)
  })
  it('never joins two different receipts', () => {
    expect(
      clusterSessions(
        [
          mk({ id: 1, started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:30:00Z', ...qc('A') }),
          mk({ id: 2, started_at: '2026-01-01T00:30:10Z', ended_at: '2026-01-01T01:00:00Z', ...qc('B') }),
        ],
        GAP,
      ),
    ).toHaveLength(2)
  })
})

describe('mergeCluster', () => {
  it('sums energy/cost and spans SOC/range; keeps authoritative cost_source', () => {
    const { survivorId, absorbedIds, set } = mergeCluster([
      mk({ id: 12, started_at: '2026-05-03T04:54:00Z', ended_at: '2026-05-03T07:36:00Z', ...qc('13191709'), energy_added_kwh: 19.82, energy_used_kwh: 22.59, cost_amount: 22.5885, cost_source: 'quickcharge', start_battery_level: 49, end_battery_level: 82, start_range_mi: 131, end_range_mi: 217 }),
      mk({ id: 13, started_at: '2026-05-03T07:37:00Z', ended_at: '2026-05-03T08:31:00Z', ...qc('13191709'), energy_added_kwh: 8.24, energy_used_kwh: 9.39, cost_amount: 9.391, cost_source: 'quickcharge' }),
      mk({ id: 14, started_at: '2026-05-03T08:31:00Z', ended_at: '2026-05-03T08:51:00Z', ...qc('13191709'), energy_added_kwh: 2.08, energy_used_kwh: 2.37, cost_amount: 2.3705, cost_source: 'quickcharge', start_battery_level: 96, end_battery_level: 100, end_range_mi: 264 }),
    ])
    expect(survivorId).toBe(12)
    expect(absorbedIds).toEqual([13, 14])
    expect(set.ended_at).toBe('2026-05-03T08:51:00Z')
    expect(set.cost_amount).toBe(34.35)
    expect(Math.round((set.energy_added_kwh ?? 0) * 100) / 100).toBe(30.14)
    expect(set.start_battery_level).toBe(49)
    expect(set.end_battery_level).toBe(100)
    expect(set.cost_source).toBe('quickcharge')
  })
})

describe('planMerges', () => {
  it('clusters per (user_id, vin) and never merges across vehicles', () => {
    const plans = planMerges(
      [
        mk({ id: 1, vin: 'A', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:30:00Z' }),
        mk({ id: 2, vin: 'B', started_at: '2026-01-01T00:30:10Z', ended_at: '2026-01-01T01:00:00Z' }),
      ],
      GAP,
    )
    expect(plans).toHaveLength(0) // different vins → two singletons, nothing to merge
  })
})
