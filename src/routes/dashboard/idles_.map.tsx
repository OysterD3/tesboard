import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { MapFilterControls } from '../../components/dashboard/MapFilterControls'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { mergeNearbyPoints, type LatLng } from '../../lib/map-vm'
import { buildIdles } from '../../lib/idles-vm'
import { inRangeMs, lastChargeMsOf, resolveRange } from '../../lib/range-filter'

export const Route = createFileRoute('/dashboard/idles_/map')({
  component: IdlesMapPage,
})

const dashApi = getRouteApi('/dashboard')
const COLOR = SECTION.idles

/**
 * Dedicated full-screen route map (`/dashboard/idles/map`). Un-nested from the
 * Idles list (the `idles_` prefix) so it renders edge-to-edge in the dashboard
 * shell. Each idle is a single park-location pin (the preceding drive's end);
 * repeat visits to the same place are merged by proximity (150m) into one pin —
 * the same single-location treatment the Charging map uses. Derived entirely from
 * the already-loaded drives, so there's no extra fetch.
 */
function IdlesMapPage() {
  const { drives, charging, now } = dashApi.useLoaderData()
  const { theme, range, setRange } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const resolved = useMemo(() => resolveRange(range, nowMs, lastChargeMs), [range, nowMs, lastChargeMs])
  const idles = useMemo(
    () => buildIdles(drives.drives).filter((i) => inRangeMs(i.startMs, resolved)),
    [drives.drives, resolved],
  )
  const pins = useMemo<MapPoint[]>(() => {
    const pts: LatLng[] = idles
      .filter((i) => i.lat != null && i.lng != null)
      .map((i) => [i.lat as number, i.lng as number])
    return mergeNearbyPoints(pts).map((p) => ({ lat: p.lat, lng: p.lng }))
  }, [idles])

  const toHistory = () => navigate({ to: '/dashboard/idles', search: (prev) => prev })
  const hasPins = pins.length > 0

  return (
    <MapOverlay
      onBack={toHistory}
      topLeft={
        <MapFilterControls
          section="idles"
          range={range}
          onRangeChange={setRange}
          accent={COLOR}
          isDark={isDark}
          nowMs={nowMs}
          lastChargeMs={lastChargeMs}
        />
      }
      caption={
        hasPins
          ? `${idles.length} idle${idles.length === 1 ? '' : 's'} · ${pins.length} parked place${pins.length === 1 ? '' : 's'}`
          : null
      }
    >
      {hasPins ? (
        <LifetimeMap fill points={pins} routeColor={COLOR} markerColor={COLOR} isDark={isDark} />
      ) : (
        <MapMessage>No parked locations recorded yet.</MapMessage>
      )}
    </MapOverlay>
  )
}
