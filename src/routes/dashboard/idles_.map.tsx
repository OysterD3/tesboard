import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Segmented } from '../../components/dashboard/primitives'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { mergeNearbyPoints, type LatLng } from '../../lib/map-vm'
import { buildIdles } from '../../lib/idles-vm'

export const Route = createFileRoute('/dashboard/idles_/map')({
  component: IdlesMapPage,
})

const dashApi = getRouteApi('/dashboard')
const COLOR = SECTION.idles

const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
]

/**
 * Dedicated full-screen route map (`/dashboard/idles/map`). Un-nested from the
 * Idles list (the `idles_` prefix) so it renders edge-to-edge in the dashboard
 * shell. Each idle is a single park-location pin (the preceding drive's end);
 * repeat visits to the same place are merged by proximity (150m) into one pin —
 * the same single-location treatment the Charging map uses. Derived entirely from
 * the already-loaded drives, so there's no extra fetch.
 */
function IdlesMapPage() {
  const { drives } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const idles = useMemo(() => buildIdles(drives.drives), [drives])
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
        <Segmented
          options={VIEW_OPTIONS}
          value="map"
          onChange={(v) => {
            if (v === 'history') toHistory()
          }}
          accent={COLOR}
          isDark={isDark}
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
