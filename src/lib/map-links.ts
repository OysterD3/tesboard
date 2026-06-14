/**
 * Map deep-links for drive start/end coordinates. Pure URL builders — the
 * coordinates are only sent to the provider when the user clicks the link;
 * nothing is fetched automatically (consistent with the app's no-third-party
 * data stance). Supports Google Maps and OpenStreetMap.
 */

function fmt(n: number): string {
  return n.toFixed(6)
}

export type MapProvider = 'google' | 'osm'

/** Driving directions from start → end. */
export function routeUrl(
  provider: MapProvider,
  sLat: number,
  sLng: number,
  eLat: number,
  eLng: number,
): string {
  if (provider === 'google') {
    return `https://www.google.com/maps/dir/?api=1&origin=${fmt(sLat)},${fmt(sLng)}&destination=${fmt(eLat)},${fmt(eLng)}&travelmode=driving`
  }
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${fmt(sLat)}%2C${fmt(sLng)}%3B${fmt(eLat)}%2C${fmt(eLng)}`
}

/** A single point marker. */
export function pointUrl(provider: MapProvider, lat: number, lng: number): string {
  if (provider === 'google') {
    return `https://www.google.com/maps/search/?api=1&query=${fmt(lat)},${fmt(lng)}`
  }
  return `https://www.openstreetmap.org/?mlat=${fmt(lat)}&mlon=${fmt(lng)}#map=16/${fmt(lat)}/${fmt(lng)}`
}
