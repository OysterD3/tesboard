/**
 * Pure helpers for grouping charge sessions into physical locations. No DB —
 * unit-testable. Supercharger sessions group by Tesla's site name; home/AC
 * sessions (which have only lat/lng) group by a rounded ~110m coordinate grid.
 * No external geocoding — coordinates never leave the app.
 */

/** Round a coordinate to a grid cell (~110m at 3 dp). */
export function roundCoord(n: number, dp = 3): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export interface LocationKeyInput {
  source: string
  location_name: string | null
  lat: number | null
  lng: number | null
}

/** Grouping key: SC → normalized site name; home/AC → rounded coord grid. */
export function locationKey(s: LocationKeyInput): string {
  if (s.source === 'supercharger') {
    const name = s.location_name?.trim().toLowerCase()
    return name ? `sc:${name}` : 'sc:unknown'
  }
  if (s.lat != null && s.lng != null) {
    return `geo:${roundCoord(s.lat)},${roundCoord(s.lng)}`
  }
  return 'unknown'
}

/** kW formatter, mirroring the money/kwh/miles helpers in Stat.tsx. */
export function kw(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 10) / 10} kW`
}
