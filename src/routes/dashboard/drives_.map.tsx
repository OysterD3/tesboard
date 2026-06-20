import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { mergeNearbyPoints } from '../../lib/map-vm'
import { getDriveRoutes, type DriveRoutesMap } from '../../functions/drives.functions'

export const Route = createFileRoute('/dashboard/drives_/map')({
  component: DrivesMapPage,
})

const dashApi = getRouteApi('/dashboard')
const COLOR = SECTION.drives

/**
 * Dedicated full-screen route map (`/dashboard/drives/map`). Un-nested from the
 * Drives list (the `drives_` prefix) so it renders edge-to-edge in the dashboard
 * shell, with the History/Map toggle + back button navigating to the list rather
 * than flipping in-page state. Every drive is drawn as its own road-matched GPS
 * polyline; the route map is fetched on mount (and re-fetched on a car switch).
 * Road-matching itself is run from Settings → Backfill.
 */
function DrivesMapPage() {
  const { activeVin } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const fetchRoutes = useServerFn(getDriveRoutes)
  const [routesMap, setRoutesMap] = useState<DriveRoutesMap | null>(null)
  const [routesLoading, setRoutesLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRoutesLoading(true)
    setRoutesMap(null)
    fetchRoutes({ data: { vin: activeVin ?? undefined } })
      .then((r) => {
        if (!cancelled) setRoutesMap(r)
      })
      .catch(() => {
        if (!cancelled) setRoutesMap({ routes: [], driveCount: 0 })
      })
      .finally(() => {
        if (!cancelled) setRoutesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [fetchRoutes, activeVin])

  // Drive start/end pins. Most routes share the same driveway / destination, so
  // the raw endpoints are merged by proximity (150m, same as the charge map) into
  // one pin per distinct place instead of hundreds of stacked dots; tapping zooms in.
  const drivePins = useMemo<MapPoint[]>(() => {
    if (!routesMap) return []
    const endpoints: [number, number][] = []
    for (const r of routesMap.routes) {
      if (r.length === 0) continue
      endpoints.push(r[0], r[r.length - 1])
    }
    return mergeNearbyPoints(endpoints).map((p) => ({ lat: p.lat, lng: p.lng }))
  }, [routesMap])

  const toHistory = () => navigate({ to: '/dashboard/drives', search: (prev) => prev })
  const hasRoutes = !!routesMap && routesMap.routes.length > 0

  return (
    <MapOverlay
      onBack={toHistory}
      topLeft={<SectionTabs section="drives" value="map" accent={COLOR} isDark={isDark} />}
      caption={
        hasRoutes
          ? `${routesMap!.driveCount} route${routesMap!.driveCount === 1 ? '' : 's'} · ${drivePins.length} start/end place${drivePins.length === 1 ? '' : 's'} · road-matched (drives too GPS-sparse to snap are hidden)`
          : null
      }
    >
      {hasRoutes ? (
        <LifetimeMap fill routes={routesMap!.routes} points={drivePins} routeColor={COLOR} markerColor={COLOR} isDark={isDark} />
      ) : (
        <MapMessage>{routesLoading || !routesMap ? 'Building route map…' : 'No GPS routes recorded yet.'}</MapMessage>
      )}
    </MapOverlay>
  )
}
