import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { LifetimeMap, MapMessage, MapOverlay } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { clusterChargePoints } from '../../lib/map-vm'

export const Route = createFileRoute('/dashboard/charging_/map')({
  component: ChargingMapPage,
})

const dashApi = getRouteApi('/dashboard')
const COLOR = SECTION.charging

/**
 * Dedicated full-screen charge map (`/dashboard/charging/map`). Un-nested from
 * the Charging list (the `charging_` prefix) so it renders edge-to-edge in the
 * dashboard shell; the History/Map toggle + back button navigate to the list.
 * Charge places come straight from the already-loaded sessions (clustered within
 * 150m) — no extra fetch.
 */
function ChargingMapPage() {
  const { charging } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const points = useMemo(() => clusterChargePoints(charging.sessions), [charging.sessions])
  const totalCharges = useMemo(() => points.reduce((s, p) => s + p.count, 0), [points])

  const toHistory = () => navigate({ to: '/dashboard/charging', search: (prev) => prev })
  const hasPoints = points.length > 0

  return (
    <MapOverlay
      onBack={toHistory}
      topLeft={<SectionTabs section="charging" value="map" accent={COLOR} isDark={isDark} />}
      caption={
        hasPoints
          ? `${points.length} location${points.length === 1 ? '' : 's'} · ${totalCharges} charge${totalCharges === 1 ? '' : 's'} · charges within 150m merge; tap a place to zoom in`
          : null
      }
    >
      {hasPoints ? (
        <LifetimeMap fill points={points} routeColor={COLOR} markerColor={COLOR} isDark={isDark} />
      ) : (
        <MapMessage>No charge locations yet — sessions need a recorded location to map.</MapMessage>
      )}
    </MapOverlay>
  )
}
