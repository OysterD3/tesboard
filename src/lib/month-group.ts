/**
 * Month bucketing for the long drive/charge lists: build the filter options and
 * flatten items into month-headed sections for a single virtualized list. Pure —
 * the rows already arrive newest-first, and we preserve that order.
 */
export interface MonthItem {
  monthKey: string
  monthLabel: string
}

export interface MonthOption {
  /** 'all' or a YYYY-MM key. */
  key: string
  /** 'All' or e.g. 'May 2026'. */
  label: string
  /** Rows in that month ('all' carries the grand total). */
  count: number
}

/** Distinct months present, newest-first (input order), prefixed with an "All" option. */
export function monthOptions<T extends MonthItem>(items: T[]): MonthOption[] {
  const seen = new Map<string, { label: string; count: number }>()
  for (const it of items) {
    const e = seen.get(it.monthKey)
    if (e) e.count++
    else seen.set(it.monthKey, { label: it.monthLabel, count: 1 })
  }
  const months = [...seen.entries()].map(([key, v]) => ({ key, label: v.label, count: v.count }))
  return [{ key: 'all', label: 'All', count: items.length }, ...months]
}

export type GroupRow<T> =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'item'; key: string; item: T }

/**
 * Flatten into [header, item, item, …, header, …] preserving order, so one
 * virtualized list can render month section headers inline. `getId` keys items.
 */
export function groupByMonth<T extends MonthItem>(
  items: T[],
  getId: (item: T) => string,
): GroupRow<T>[] {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(it.monthKey, (counts.get(it.monthKey) ?? 0) + 1)

  const rows: GroupRow<T>[] = []
  let cur: string | null = null
  for (const it of items) {
    if (it.monthKey !== cur) {
      cur = it.monthKey
      rows.push({ kind: 'header', key: `h:${it.monthKey}`, label: it.monthLabel, count: counts.get(it.monthKey) ?? 0 })
    }
    rows.push({ kind: 'item', key: getId(it), item: it })
  }
  return rows
}
