import { useEffect, useRef, type ReactNode } from 'react'
import type * as Leaflet from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { cn } from '../../lib/utils'
import { mapClass } from './LeafletMap'
import { clusterHtml, dotHtml, clusterSizeFor } from './LifetimeMapMarkers'

export interface MapPoint {
  lat: number
  lng: number
  /** Dot color override (defaults to `markerColor`) — e.g. a muted drive-start vs an accent drive-end pin. */
  color?: string
}

/**
 * Lifetime map for the Drives / Charging "Map" tabs: every drive as its own GPS
 * polyline, plus point markers (charge places, or drive start/end endpoints)
 * clustered with leaflet.markercluster — a numbered bubble shows how many markers
 * it merges (via `getChildCount`). Tapping either a numbered bubble or an
 * individual dot zooms the map toward it; the map never navigates away.
 * Leaflet + the cluster plugin touch `window`, so they're dynamically imported
 * inside the effect — they never enter the SSR/Workers bundle. Dark mode filters
 * the tile pane (see `.evd-map-dark`).
 */
export function LifetimeMap({
  routes = [],
  points = [],
  routeColor,
  markerColor,
  isDark,
  height = 460,
  fill = false,
}: {
  routes?: [number, number][][]
  points?: MapPoint[]
  routeColor: string
  markerColor: string
  isDark: boolean
  height?: number
  /** Fill the (positioned) parent edge-to-edge instead of a fixed-height rounded
   *  card — used by the full-screen Map tab (see `MapOverlay`). Also enables
   *  scroll-wheel zoom, since there's no page scroll to preserve. */
  fill?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Leaflet.Map | null>(null)
  const layersRef = useRef<Leaflet.Layer[]>([])

  useEffect(() => {
    let cancelled = false

    async function render() {
      const mod = await import('leaflet')
      const L = ((mod as unknown as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet
      await import('leaflet.markercluster') // augments L with markerClusterGroup
      if (cancelled || !containerRef.current) return

      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: true,
          dragging: true,
          scrollWheelZoom: fill,
        })
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap',
          maxZoom: 19,
        }).addTo(mapRef.current)
      }
      const map = mapRef.current

      for (const l of layersRef.current) map.removeLayer(l)
      layersRef.current = []

      // Drive route polylines.
      for (const path of routes) {
        if (path.length < 2) continue
        const line = L.polyline(path, { color: routeColor, weight: 3, opacity: 0.75, lineJoin: 'round', lineCap: 'round' }).addTo(map)
        layersRef.current.push(line)
      }

      // Point markers — plain dots (a charge place, or a drive start/end endpoint).
      // Each is a bare dot with NO number; tapping it zooms the map toward it. When
      // dots sit close enough to overlap at the current zoom, leaflet.markercluster
      // groups them into one numbered bubble whose count is how many markers it
      // covers (getChildCount); tapping the bubble zooms in and splits it apart. The
      // map never navigates away — drilling into a session is done from the list.
      let clusters: Leaflet.MarkerClusterGroup | null = null
      if (points.length > 0) {
        const badge = (n: number) => {
          const size = clusterSizeFor(n)
          return L.divIcon({
            html: clusterHtml(n, size, markerColor),
            className: '',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          })
        }
        clusters = L.markerClusterGroup({
          showCoverageOnHover: false,
          maxClusterRadius: 48,
          iconCreateFunction: (cluster) => badge(cluster.getChildCount()),
        })
        // One dot icon per distinct color (markerColor default; points may override).
        const dotCache = new Map<string, Leaflet.DivIcon>()
        const dotFor = (color: string) => {
          let icon = dotCache.get(color)
          if (!icon) {
            icon = L.divIcon({ html: dotHtml(color), className: '', iconSize: [16, 16], iconAnchor: [8, 8] })
            dotCache.set(color, icon)
          }
          return icon
        }
        // Tapping a lone dot flies the map toward it (a clustered dot's tap is handled
        // by the cluster's default zoom-to-bounds) — so every tap zooms in, never navigates.
        const zoomTo = (lat: number, lng: number) => {
          const target = Math.min(Math.max(map.getZoom() + 3, 15), map.getMaxZoom())
          map.flyTo([lat, lng], target, { duration: 0.6 })
        }
        for (const p of points) {
          const m = L.marker([p.lat, p.lng], { icon: dotFor(p.color ?? markerColor) })
          m.on('click', () => zoomTo(p.lat, p.lng))
          clusters.addLayer(m)
        }
        map.addLayer(clusters)
        layersRef.current.push(clusters)
      }

      // Fit to everything (routes + points).
      const all: [number, number][] = [...routes.flat(), ...points.map((p) => [p.lat, p.lng] as [number, number])]
      if (all.length > 0) map.fitBounds(L.latLngBounds(all), { padding: [28, 28], maxZoom: 15 })
      else map.setView([0, 0], 2)
      // Layout can settle after the async import; make sure tiles fill the box.
      setTimeout(() => map.invalidateSize(), 0)
    }

    render()
    return () => {
      cancelled = true
    }
  }, [routes, points, routeColor, markerColor])

  // Keep the map sized to its box on viewport changes (matters for the full-screen
  // `fill` map / device rotation), and tear it down only on unmount.
  useEffect(() => {
    const onResize = () => mapRef.current?.invalidateSize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      // fill: z-0 makes the map its own stacking context so Leaflet's internal panes
      // (z-index 200–700) can't paint over the floating MapOverlay controls.
      className={mapClass(
        isDark,
        fill ? 'absolute inset-0 z-0' : 'w-full rounded-2xl overflow-hidden border border-border',
      )}
      style={fill ? undefined : { height }}
    />
  )
}

/**
 * Full-screen immersive shell for the Drives / Charging "Map" tab. Pins a
 * `fill`-mode map to the entire viewport (edge-to-edge, full height) and floats
 * the controls over it: the view toggle (top-left), an optional action like
 * Snap-to-roads (top-right), and a legibility-pilled caption near the bottom. The
 * floating bottom nav keeps its higher z-index (this sits at z-index 10), and the
 * transparent gaps around the controls pass touches through so the map still pans.
 * Inherits the dashboard theme CSS vars since it renders inside the themed shell.
 */
export function MapOverlay({
  onBack,
  topLeft,
  topRight,
  caption,
  children,
}: {
  /** When set, a circular back button is floated at the very top-left that exits
   *  the full-screen map (e.g. back to the History list). */
  onBack?: () => void
  topLeft?: ReactNode
  topRight?: ReactNode
  caption?: ReactNode
  children: ReactNode
}) {
  // drop-shadow on the floating controls; arbitrary util shared by all three wrappers.
  const floatShadow = '[filter:drop-shadow(0_2px_8px_rgba(0,0,0,0.18))]'
  return (
    <div className="fixed inset-0 z-10 bg-background">
      {children}
      <div className="absolute left-3.5 right-3.5 top-[calc(env(safe-area-inset-top,0px)+14px)] z-[2] flex items-start justify-between gap-2 pointer-events-none">
        <div className="flex items-start gap-2 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className={cn(
                'pointer-events-auto flex-none size-[38px] rounded-full border border-border bg-card flex items-center justify-center cursor-pointer',
                floatShadow,
              )}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--tx,#1d1d1f)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          {topLeft != null && (
            <div className={cn('pointer-events-auto flex gap-2 flex-wrap', floatShadow)}>{topLeft}</div>
          )}
        </div>
        {topRight != null && (
          <div className={cn('pointer-events-auto flex gap-2 flex-wrap justify-end', floatShadow)}>{topRight}</div>
        )}
      </div>
      {caption != null && (
        <div className="absolute left-3.5 right-3.5 bottom-[calc(env(safe-area-inset-bottom,0px)+92px)] z-[2] flex justify-center pointer-events-none">
          <div className="pointer-events-auto max-w-full bg-card border border-border rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.12)] px-3 py-[7px] text-[10.5px] font-medium text-muted-foreground text-center">
            {caption}
          </div>
        </div>
      )}
    </div>
  )
}

/** Centered loading / empty message that fills a `MapOverlay` when there's no map to draw. */
export function MapMessage({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-center p-6 bg-secondary">
      <span className="text-[13px] font-medium text-muted-foreground">{children}</span>
    </div>
  )
}
