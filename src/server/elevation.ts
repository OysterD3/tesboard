/**
 * Terrain elevation lookup via the Open-Meteo Elevation API (free, no API key,
 * global; Copernicus DEM ~90 m). The Fleet API's drive_state has no altitude, so
 * elevation is derived after the fact from the lat/lng the poller already stored
 * — exactly like the Nominatim reverse-geocode backfill (geocode.ts). DEM gives
 * *ground* elevation at the coordinate (off on bridges/garages, fine for a
 * profile). Kept OFF the cron; an on-demand backfill calls this in batches.
 *
 * Open-Meteo accepts up to 100 coordinates per request as comma-joined
 * latitude/longitude lists and returns `{ "elevation": number[] }` aligned to
 * the input order. Self-host / override the host with OPEN_METEO_BASE_URL.
 */
const OPEN_METEO_BASE =
  (typeof process !== 'undefined' && process.env?.OPEN_METEO_BASE_URL) || 'https://api.open-meteo.com'

/** Max coordinates Open-Meteo accepts in one elevation request. */
export const ELEVATION_BATCH = 100

/**
 * Look up ground elevation (metres) for up to `ELEVATION_BATCH` coordinates in a
 * single request. Returns an array aligned to `coords`; any entry is null on a
 * failed request or a malformed/short response (caller leaves those for a retry).
 */
export async function lookupElevations(coords: [number, number][]): Promise<(number | null)[]> {
  if (coords.length === 0) return []
  try {
    const lat = coords.map((c) => c[0]).join(',')
    const lng = coords.map((c) => c[1]).join(',')
    const url = `${OPEN_METEO_BASE}/v1/elevation?latitude=${lat}&longitude=${lng}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return coords.map(() => null)
    const json = (await res.json()) as { elevation?: unknown }
    const els = json.elevation
    if (!Array.isArray(els) || els.length !== coords.length) return coords.map(() => null)
    return els.map((e) => (typeof e === 'number' && Number.isFinite(e) ? e : null))
  } catch {
    return coords.map(() => null)
  }
}
