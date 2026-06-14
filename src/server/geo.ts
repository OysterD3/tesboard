/**
 * Geo helpers shared by the poller (geofence classification) and the
 * charging-location grouping. Pure functions, no DB — unit-testable.
 */
import type { ChargeLocationType } from '../types/db'

const EARTH_RADIUS_M = 6_371_000

/** Great-circle distance in METRES between two lat/lng points (haversine). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

const DEFAULT_HOME_RADIUS_M = 150

/**
 * Classify a charge session's physical location into the geofence verdict.
 *  - 'supercharger' wins outright (power-based classification owns SC).
 *  - else compare the session's start coords to the user's home geofence.
 *  - 'unknown' when we can't tell (no home set, or no coords) — never guess.
 */
export function classifyChargeLocation(
  source: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  home: { home_lat: number | null; home_lng: number | null; home_radius_m: number | null } | null,
): ChargeLocationType {
  if (source === 'supercharger') return 'supercharger'
  if (lat == null || lng == null) return 'unknown'
  if (!home || home.home_lat == null || home.home_lng == null) return 'unknown'
  const radius = home.home_radius_m ?? DEFAULT_HOME_RADIUS_M
  const d = haversineMeters(lat, lng, home.home_lat, home.home_lng)
  return d <= radius ? 'home' : 'away'
}
