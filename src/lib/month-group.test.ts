import { describe, expect, it } from 'vitest'
import { groupByMonth, monthOptions, type MonthItem } from './month-group'

interface Row extends MonthItem {
  id: string
}

const rows: Row[] = [
  { id: 'a', monthKey: '2026-06', monthLabel: 'Jun 2026' },
  { id: 'b', monthKey: '2026-06', monthLabel: 'Jun 2026' },
  { id: 'c', monthKey: '2026-05', monthLabel: 'May 2026' },
]

describe('monthOptions', () => {
  it('prefixes "All" with the grand total, then distinct months in input order', () => {
    expect(monthOptions(rows)).toEqual([
      { key: 'all', label: 'All', count: 3 },
      { key: '2026-06', label: 'Jun 2026', count: 2 },
      { key: '2026-05', label: 'May 2026', count: 1 },
    ])
  })

  it('returns only "All" for an empty list', () => {
    expect(monthOptions([])).toEqual([{ key: 'all', label: 'All', count: 0 }])
  })
})

describe('groupByMonth', () => {
  it('inserts a header before each month group and preserves item order', () => {
    const out = groupByMonth(rows, (r) => r.id)
    expect(out.map((r) => (r.kind === 'header' ? `#${r.label}(${r.count})` : r.key))).toEqual([
      '#Jun 2026(2)',
      'a',
      'b',
      '#May 2026(1)',
      'c',
    ])
  })

  it('produces nothing for an empty list', () => {
    expect(groupByMonth([] as Row[], (r) => r.id)).toEqual([])
  })
})
