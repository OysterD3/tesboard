import { SectionTabs } from './SectionTabs'
import { RangeFilter } from './RangeFilter'
import type { RangeState } from '../../lib/range-filter'

/**
 * Stacked controls floated at the top-left of a full-screen Map overlay: the
 * History / Map / Insights toggle above the date-range dropdown. The range
 * filter is a compact Select pill (its popover is portaled + viewport-bounded by
 * Radix, so it never spills off-screen) and clears the overlay's back button.
 */
export function MapFilterControls({
  section,
  range,
  onRangeChange,
  accent,
  isDark,
  nowMs,
  lastChargeMs,
}: {
  section: 'drives' | 'charging' | 'idles'
  range: RangeState
  onRangeChange: (s: RangeState) => void
  accent: string
  isDark: boolean
  nowMs: number
  lastChargeMs?: number | null
}) {
  return (
    <div className="flex flex-col gap-2 pointer-events-auto">
      <SectionTabs section={section} value="map" accent={accent} isDark={isDark} />
      <RangeFilter
        state={range}
        onChange={onRangeChange}
        accent={accent}
        isDark={isDark}
        nowMs={nowMs}
        lastChargeMs={lastChargeMs}
      />
    </div>
  )
}
