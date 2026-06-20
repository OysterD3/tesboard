import { type ReactNode } from 'react'
import { MapFilterControls } from './MapFilterControls'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from './LifetimeMap'
import { useDash } from './DashboardProvider'
import { SECTION } from './theme'

type Section = 'drives' | 'charging' | 'idles'

/**
 * Shared full-screen "Map" route shell for the Drives / Charging / Idles sections.
 * Owns the wiring that was duplicated near-verbatim across the three `*_.map.tsx`
 * routes — `useDash()` (theme/range) and the `MapOverlay` + `MapFilterControls` +
 * `LifetimeMap`/`MapMessage` scaffold. Each route computes its own section-specific
 * data (routes/points/caption), `nowMs`/`lastChargeMs` (from its loader data), and
 * the back navigation (`onBack`, kept per-route so TanStack typed-route checking is
 * preserved), then passes it in. The per-section accent (`SECTION[section]`) is
 * plumbed to `routeColor`/`markerColor`/`accent` here so behaviour stays
 * byte-identical to the originals.
 */
export function SectionRouteMap({
  section,
  onBack,
  nowMs,
  lastChargeMs,
  routes,
  points,
  hasContent,
  caption,
  emptyMessage,
}: {
  section: Section
  /** Exit the full-screen map (back to the section's History list). */
  onBack: () => void
  nowMs: number
  lastChargeMs: number | null
  routes?: [number, number][][]
  points?: MapPoint[]
  /** Whether there's a map to draw; false renders `emptyMessage` via MapMessage. */
  hasContent: boolean
  /** Caption shown only when `hasContent` (mirrors the old per-route caption gate). */
  caption: ReactNode
  emptyMessage: ReactNode
}) {
  const { theme, range, setRange } = useDash()
  const isDark = theme === 'dark'
  const color = SECTION[section]

  return (
    <MapOverlay
      onBack={onBack}
      topLeft={
        <MapFilterControls
          section={section}
          range={range}
          onRangeChange={setRange}
          accent={color}
          isDark={isDark}
          nowMs={nowMs}
          lastChargeMs={lastChargeMs}
        />
      }
      caption={hasContent ? caption : null}
    >
      {hasContent ? (
        <LifetimeMap fill routes={routes} points={points} routeColor={color} markerColor={color} isDark={isDark} />
      ) : (
        <MapMessage>{emptyMessage}</MapMessage>
      )}
    </MapOverlay>
  )
}
