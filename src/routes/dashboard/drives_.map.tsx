import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Segmented } from '../../components/dashboard/primitives'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { mergeNearbyPoints } from '../../lib/map-vm'
import { getDriveRoutes, type DriveRoutesMap } from '../../functions/drives.functions'
import { backfillRouteMatch } from '../../functions/routematch.functions'

export const Route = createFileRoute('/dashboard/drives_/map')({
  component: DrivesMapPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const COLOR = SECTION.drives
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
]

/**
 * Dedicated full-screen route map (`/dashboard/drives/map`). Un-nested from the
 * Drives list (the `drives_` prefix) so it renders edge-to-edge in the dashboard
 * shell, with the History/Map toggle + back button navigating to the list rather
 * than flipping in-page state. Every drive is drawn as its own road-matched GPS
 * polyline; the route map is fetched on mount (and re-fetched after a Snap-to-roads
 * pass or a car switch).
 */
function DrivesMapPage() {
  const { activeVin } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const fetchRoutes = useServerFn(getDriveRoutes)
  const [routesMap, setRoutesMap] = useState<DriveRoutesMap | null>(null)
  const [routesLoading, setRoutesLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

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
  }, [fetchRoutes, activeVin, reloadKey])

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
      topRight={hasRoutes ? <SnapToRoadsButton isDark={isDark} onDone={() => setReloadKey((k) => k + 1)} /> : null}
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

/**
 * Road-match backfill trigger for the route map. Loops `backfillRouteMatch`
 * (throttled server-side, a few drives per call) until every drive has been
 * attempted, then `onDone()` re-fetches the route map so freshly road-matched
 * drives redraw on roads. When the server reports Mapbox isn't configured the
 * label nudges to set MAPBOX_TOKEN.
 */
function SnapToRoadsButton({ isDark, onDone }: { isDark: boolean; onDone: () => void }) {
  const run = useServerFn(backfillRouteMatch)
  const [st, setSt] = useState<{ running: boolean; matched: number; remaining: number | null; done: boolean; configured: boolean }>({
    running: false,
    matched: 0,
    remaining: null,
    done: false,
    configured: true,
  })

  async function snap() {
    if (st.running) return
    setSt({ running: true, matched: 0, remaining: null, done: false, configured: true })
    let matched = 0
    let configured = true
    let stalls = 0
    try {
      for (let i = 0; i < 500; i++) {
        const r = await run()
        if (!r.configured) {
          configured = false
          break
        }
        matched += r.matched
        setSt({ running: true, matched, remaining: r.remaining, done: false, configured: true })
        if (r.remaining === 0) break
        if (r.matched + r.failed > 0) {
          stalls = 0
          await sleep(400) // pace well under Mapbox's 300 req/min
        } else {
          // No progress — rate-limited/paused. Back off and retry a few times before giving up.
          if (++stalls >= 6) break
          await sleep(8000)
        }
      }
    } catch {
      /* finalize below */
    } finally {
      onDone()
      setSt((s) => ({ ...s, running: false, done: true, configured }))
    }
  }

  const label = !st.configured
    ? 'Set MAPBOX_TOKEN to snap'
    : st.running
      ? `Snapping… ${st.matched}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
      : st.done
        ? st.remaining
          ? `Snapped ${st.matched} · ${st.remaining} left`
          : `Snapped ${st.matched}`
        : 'Snap to roads'

  return (
    <button
      type="button"
      onClick={snap}
      disabled={st.running}
      title="Road-match each drive's GPS to the street network via Mapbox (cached; needs MAPBOX_TOKEN)"
      style={{
        flex: 'none',
        cursor: st.running ? 'default' : 'pointer',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: st.running ? TD : COLOR,
        background: isDark ? 'rgba(20,20,22,0.92)' : 'var(--card,#fff)',
        border: `1px solid ${st.running ? 'var(--border,rgba(0,0,0,0.08))' : COLOR}`,
        borderRadius: 30,
        padding: '7px 14px',
        whiteSpace: 'nowrap',
        opacity: st.running ? 0.8 : 1,
      }}
    >
      {label}
    </button>
  )
}
