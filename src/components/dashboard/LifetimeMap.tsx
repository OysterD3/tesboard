import { useEffect, useRef } from 'react'
import type * as Leaflet from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface MapMarker {
  lat: number
  lng: number
  /** Sessions/visits at this spot; shown as a badge when > 1. */
  count: number
}

/**
 * Lifetime map for the Drives / Charging "Map" tabs: every drive as its own GPS
 * polyline and/or charge locations as numbered cluster markers. Leaflet touches
 * `window`, so it's dynamically imported inside the effect — it never enters the
 * SSR/Workers bundle. Pure-SVG markers (divIcon/circleMarker) dodge Leaflet's
 * image-icon issues. Dark mode filters the tile pane (see `.evd-map-dark`).
 */
export function LifetimeMap({
  routes = [],
  markers = [],
  routeColor,
  markerColor,
  isDark,
  height = 460,
}: {
  routes?: [number, number][][]
  markers?: MapMarker[]
  routeColor: string
  markerColor: string
  isDark: boolean
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Leaflet.Map | null>(null)
  const layersRef = useRef<Leaflet.Layer[]>([])

  useEffect(() => {
    let cancelled = false

    async function render() {
      const mod = await import('leaflet')
      const L = ((mod as unknown as { default?: typeof Leaflet }).default ?? mod) as typeof Leaflet
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

      const group = L.featureGroup()
      for (const path of routes) {
        if (path.length < 2) continue
        L.polyline(path, { color: routeColor, weight: 3, opacity: 0.75, lineJoin: 'round', lineCap: 'round' }).addTo(group)
      }
      for (const m of markers) {
        const big = m.count > 1
        const size = big ? 30 : 16
        const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${markerColor};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;font-family:'Geist',system-ui,sans-serif;">${big ? m.count : ''}</div>`
        L.marker([m.lat, m.lng], {
          icon: L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        }).addTo(group)
      }
      group.addTo(map)
      layersRef.current.push(group)

      const bounds = group.getBounds()
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 })
      } else {
        map.setView([0, 0], 2)
      }
      // Layout can settle after the async import; make sure tiles fill the box.
      setTimeout(() => map.invalidateSize(), 0)
    }

    render()
    return () => {
      cancelled = true
    }
  }, [routes, markers, routeColor, markerColor])

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
