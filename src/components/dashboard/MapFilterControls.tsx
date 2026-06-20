import { SectionTabs } from './SectionTabs'
import { RangeFilter } from './RangeFilter'
import type { RangeState } from '../../lib/range-filter'

/**
 * Stacked controls floated at the top-left of a full-screen Map overlay: the
 * History / Map / Insights toggle above the date-range chips. The chip row is
 * width-bounded (so it scrolls horizontally rather than spilling across the map)
 * and clears the overlay's back button.
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'auto' }}>
      <SectionTabs section={section} value="map" accent={accent} isDark={isDark} />
      <div style={{ width: 'calc(100vw - 96px)', maxWidth: 420 }}>
        <RangeFilter
          state={range}
          onChange={onRangeChange}
          accent={accent}
          isDark={isDark}
          nowMs={nowMs}
          lastChargeMs={lastChargeMs}
        />
      </div>
    </div>
  )
}
