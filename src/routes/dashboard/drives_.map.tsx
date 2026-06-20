import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useDashboardData } from '../../lib/queries'
import { SectionRouteMap } from '../../components/dashboard/SectionRouteMap'
import { type MapPoint } from '../../components/dashboard/LifetimeMap'
import { mergeNearbyPoints } from '../../lib/map-vm'
import { lastChargeMsOf, rangeToIso, resolveRange } from '../../lib/range-filter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { getDriveRoutes, type DriveRoutesMap } from '../../functions/drives.functions'

export const Route = createFileRoute('/dashboard/drives_/map')({
  component: DrivesMapPage,
})

/**
 * Dedicated full-screen route map (`/dashboard/drives/map`). Un-nested from the
 * Drives list (the `drives_` prefix) so it renders edge-to-edge in the dashboard
 * shell, with the History/Map toggle + back button navigating to the list rather
 * than flipping in-page state. Every drive is drawn as its own road-matched GPS
 * polyline; the route map is fetched on mount (and re-fetched on a car switch).
 * Road-matching itself is run from Settings → Backfill. Shared map scaffolding
 * lives in <SectionRouteMap>; this file owns the drive-specific route fetch + pins.
 */
function DrivesMapPage() {
  const { activeVin, charging, now } = useDashboardData()
  const { range } = useDash()
  const navigate = useNavigate()

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const { from, to } = rangeToIso(resolveRange(range, nowMs, lastChargeMs))

  const fetchRoutes = useServerFn(getDriveRoutes)
  const [routesMap, setRoutesMap] = useState<DriveRoutesMap | null>(null)
  const [routesLoading, setRoutesLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRoutesLoading(true)
    setRoutesMap(null)
    fetchRoutes({ data: { vin: activeVin ?? undefined, from, to } })
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
  }, [fetchRoutes, activeVin, from, to])

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

  const hasRoutes = !!routesMap && routesMap.routes.length > 0

  return (
    <SectionRouteMap
      section="drives"
      onBack={() => navigate({ to: '/dashboard/drives', search: (prev) => prev })}
      nowMs={nowMs}
      lastChargeMs={lastChargeMs}
      routes={routesMap?.routes}
      points={drivePins}
      hasContent={hasRoutes}
      caption={
        hasRoutes
          ? `${routesMap!.driveCount} route${routesMap!.driveCount === 1 ? '' : 's'} · ${drivePins.length} start/end place${drivePins.length === 1 ? '' : 's'} · road-matched (drives too GPS-sparse to snap are hidden)`
          : null
      }
      emptyMessage={routesLoading || !routesMap ? 'Building route map…' : 'No GPS routes recorded yet.'}
    />
  )
}
