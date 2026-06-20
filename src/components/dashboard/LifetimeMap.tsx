import { useEffect, useRef, type ReactNode } from 'react'
import type * as Leaflet from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'

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
        const sizeFor = (n: number) => (n < 10 ? 34 : n < 100 ? 40 : 46)
        const badge = (n: number) => {
          const size = sizeFor(n)
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
      className={isDark ? 'evd-map evd-map-dark' : 'evd-map'}
      style={
        fill
          ? { position: 'absolute', inset: 0 }
          : { height, width: '100%', borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border,rgba(0,0,0,0.07))' }
      }
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
  topLeft,
  topRight,
  caption,
  children,
}: {
  topLeft?: ReactNode
  topRight?: ReactNode
  caption?: ReactNode
  children: ReactNode
}) {
  const floatShadow = 'drop-shadow(0 2px 8px rgba(0,0,0,0.18))'
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10, background: 'var(--bg,#f5f5f7)' }}>
      {children}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
          left: 14,
          right: 14,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 2,
        }}
      >
        {topLeft != null && (
          <div style={{ pointerEvents: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', filter: floatShadow }}>{topLeft}</div>
        )}
        {topRight != null && (
          <div style={{ pointerEvents: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', filter: floatShadow }}>
            {topRight}
          </div>
        )}
      </div>
      {caption != null && (
        <div
          style={{
            position: 'absolute',
            left: 14,
            right: 14,
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 92px)',
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              maxWidth: '100%',
              background: 'var(--card,#fff)',
              border: '1px solid var(--border,rgba(0,0,0,0.07))',
              borderRadius: 12,
              boxShadow: '0 2px 10px rgba(0,0,0,0.12)',
              padding: '7px 12px',
              fontSize: 10.5,
              fontWeight: 500,
              color: 'var(--td,#86868b)',
              textAlign: 'center',
            }}
          >
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
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 24,
        background: 'var(--track,#f0f0f3)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--td,#86868b)' }}>{children}</span>
    </div>
  )
}

function clusterHtml(n: number, size: number, color: string): string {
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;font-family:'Geist',system-ui,sans-serif;">${n}</div>`
}

function dotHtml(color: string): string {
  return `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`
}
