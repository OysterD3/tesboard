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
import { sql } from 'drizzle-orm'
import type { Db } from './db'

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

/** A snapshot needing elevation: its id + GPS fix. */
export interface ElevationFillRow {
  id: number
  lat: number
  lng: number
}

/**
 * Look up + persist elevation for up to `maxBatches × ELEVATION_BATCH` snapshots
 * (one Open-Meteo request + one bulk SQL update per batch), scoped to `userId`.
 * Idempotent and best-effort: coordinates Open-Meteo can't resolve are left null
 * for a later retry. Returns the count written, the request count, and a map of
 * id → metres so the caller can apply the values in-memory without re-querying.
 */
export async function fillElevations(
  db: Db,
  userId: string,
  rows: ElevationFillRow[],
  maxBatches = 5,
): Promise<{ filled: number; batches: number; byId: Map<number, number> }> {
  const byId = new Map<number, number>()
  let filled = 0
  let batches = 0
  const limit = Math.min(rows.length, maxBatches * ELEVATION_BATCH)
  for (let i = 0; i < limit; i += ELEVATION_BATCH) {
    const chunk = rows.slice(i, i + ELEVATION_BATCH)
    const els = await lookupElevations(chunk.map((r) => [r.lat, r.lng]))
    batches++
    const pairs: { id: number; ele: number }[] = []
    for (let j = 0; j < chunk.length; j++) {
      const e = els[j]
      if (e == null) continue
      const ele = Math.round(e)
      pairs.push({ id: chunk[j].id, ele })
      byId.set(chunk[j].id, ele)
    }
    if (pairs.length === 0) continue
    // One bulk update per batch: join the snapshots to a VALUES list by id. The
    // user_id predicate keeps the write scoped even though the ids are the user's.
    const valuesSql = sql.join(
      pairs.map((p) => sql`(${p.id}::bigint, ${p.ele}::int)`),
      sql`, `,
    )
    await db.execute(sql`
      update vehicle_snapshot as v
      set elevation_m = d.ele
      from (values ${valuesSql}) as d(id, ele)
      where v.id = d.id and v.user_id = ${userId}
    `)
    filled += pairs.length
  }
  return { filled, batches, byId }
}
