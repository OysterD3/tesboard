import { useEffect, useRef } from 'react'
import type * as Leaflet from 'leaflet'
import 'leaflet/dist/leaflet.css'

/**
 * Free OpenStreetMap basemap (Leaflet + OSM raster tiles, no API key) showing a
 * drive's breadcrumb. Leaflet touches `window`, so it's dynamically imported
 * inside the effect — it never enters the SSR/Workers bundle. Start/end use
 * circleMarkers (pure SVG) to dodge Leaflet's image-based default-icon issues.
 * Dark mode filters the tile pane (see `.evd-map-dark` in styles.css).
 */
export function LeafletMap({
  points,
  color,
  isDark,
  height = 206,
  mode = 'route',
}: {
  points: [number, number][]
  color: string
  isDark: boolean
  height?: number
  /** 'route' = connected breadcrumb + start/end dots (a single drive); 'scatter'
   *  = unconnected dots that fit all points (the lifetime "visited" map). */
  mode?: 'route' | 'scatter'
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
      if (points.length === 0) return

      if (mode === 'scatter') {
        const group = L.featureGroup()
        for (const p of points) {
          L.circleMarker(p, { radius: 3, color, weight: 0, fillColor: color, fillOpacity: 0.5 }).addTo(group)
        }
        group.addTo(map)
        layersRef.current.push(group)
        if (points.length === 1) map.setView(points[0], 13)
        else map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 15 })
        setTimeout(() => map.invalidateSize(), 0)
        return
      }

      if (points.length >= 2) {
        const line = L.polyline(points, { color, weight: 4, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(map)
        layersRef.current.push(line)
        map.fitBounds(line.getBounds(), { padding: [24, 24], maxZoom: 16 })
      } else {
        map.setView(points[0], 14)
      }

      const start = points[0]
      const end = points[points.length - 1]
      layersRef.current.push(
        L.circleMarker(start, { radius: 6, color: '#fff', weight: 2.5, fillColor: '#34c759', fillOpacity: 1 }).addTo(map),
      )
      layersRef.current.push(
        L.circleMarker(end, { radius: 6, color: '#fff', weight: 2.5, fillColor: color, fillOpacity: 1 }).addTo(map),
      )
      // Layout can settle after the async import; make sure tiles fill the box.
      setTimeout(() => map.invalidateSize(), 0)
    }

    render()
    return () => {
      cancelled = true
    }
  }, [points, color, mode])

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
