import { useEffect, useRef } from 'react'
import type * as Leaflet from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'

export interface MapPoint {
  lat: number
  lng: number
  /** Opaque id passed back to `onPointClick` when the place's pin is tapped (opens its most-recent session). */
  id?: string
}

/**
 * Lifetime map for the Drives / Charging "Map" tabs: every drive as its own GPS
 * polyline, and one plain dot per distinct charge place, clustered with
 * leaflet.markercluster — a numbered bubble shows how many distinct PLACES it
 * merges (via `getChildCount`, never the session total), and tapping it zooms in
 * and splits it apart, down to the individual place dots (which call `onPointClick`
 * to open that place's most-recent session).
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
  onPointClick,
}: {
  routes?: [number, number][][]
  points?: MapPoint[]
  routeColor: string
  markerColor: string
  isDark: boolean
  height?: number
  onPointClick?: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Leaflet.Map | null>(null)
  const layersRef = useRef<Leaflet.Layer[]>([])
  // Kept in a ref so a new onPointClick identity doesn't rebuild the whole map.
  const clickRef = useRef(onPointClick)
  useEffect(() => {
    clickRef.current = onPointClick
  })

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
          scrollWheelZoom: false,
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

      // Point markers — one per distinct charge LOCATION (clusterChargePoints has
      // already collapsed every charge within its radius into a single place). Each
      // place is a plain dot with NO number; tapping it opens that place's
      // most-recent session. When several distinct places sit close enough to overlap
      // at the current zoom, leaflet.markercluster groups them into one numbered
      // bubble whose count is the number of PLACES it covers (getChildCount — never
      // the session total); tapping the bubble zooms in and splits it apart.
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
          // The bubble counts merged PLACES, not charge sessions.
          iconCreateFunction: (cluster) => badge(cluster.getChildCount()),
        })
        const dot = L.divIcon({ html: dotHtml(markerColor), className: '', iconSize: [16, 16], iconAnchor: [8, 8] })
        for (const p of points) {
          const m = L.marker([p.lat, p.lng], { icon: dot })
          if (p.id != null) m.on('click', () => clickRef.current?.(p.id as string))
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

  // Tear the map down only on unmount.
  useEffect(() => {
    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={isDark ? 'evd-map evd-map-dark' : 'evd-map'}
      style={{ height, width: '100%', borderRadius: 16, overflow: 'hidden', border: '1px solid var(--border,rgba(0,0,0,0.07))' }}
    />
  )
}

function clusterHtml(n: number, size: number, color: string): string {
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;font-family:'Geist',system-ui,sans-serif;">${n}</div>`
}

function dotHtml(color: string): string {
  return `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`
}
