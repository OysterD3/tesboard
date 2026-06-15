/**
 * Reverse geocoding via Nominatim/OSM → the `address` cache.
 *
 * Deliberately NOT called from the 2-min cron poller: Nominatim's usage policy
 * caps you at ~1 req/s with a descriptive User-Agent, and the cron has no slack.
 * Instead the dashboard triggers `backfillAddresses` (see locations.functions.ts)
 * which walks a few un-geocoded drive/charge endpoints per call, throttled.
 *
 * Addresses are deduped on (user_id, osm_id, osm_type) — the same natural key
 * TeslaMate uses — so repeated lookups of the same place reuse one row.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './db'
import { address } from './schema'
import type { Json } from '../types/db'

const NOMINATIM_BASE =
  (typeof process !== 'undefined' && process.env?.NOMINATIM_BASE_URL) ||
  'https://nominatim.openstreetmap.org'
const USER_AGENT = 'tesboard/1.0 (personal Tesla dashboard; reverse geocoding)'

interface NominatimResult {
  osm_id?: number
  osm_type?: string
  display_name?: string
  name?: string
  address?: Record<string, string>
}

/** Reverse-geocode one point. Returns the raw Nominatim result, or null on any error. */
export async function reverseGeocode(lat: number, lng: number): Promise<NominatimResult | null> {
  try {
    const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as NominatimResult
  } catch {
    return null
  }
}

/**
 * Resolve a point to a tesboard `address.id`, geocoding + caching as needed.
 * Returns null if geocoding fails (caller leaves the link null — never blocks).
 */
export async function findOrCreateAddress(
  db: Db,
  userId: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
): Promise<number | null> {
  if (lat == null || lng == null) return null
  const r = await reverseGeocode(lat, lng)
  if (!r) return null
  const a = r.address ?? {}
  const osmId = r.osm_id ?? null
  const osmType = r.osm_type ?? null

  const values = {
    user_id: userId,
    osm_id: osmId,
    osm_type: osmType,
    display_name: r.display_name ?? null,
    name: r.name ?? a.amenity ?? a.shop ?? null,
    house_number: a.house_number ?? null,
    road: a.road ?? null,
    neighbourhood: a.neighbourhood ?? a.suburb ?? null,
    city: a.city ?? a.town ?? a.village ?? null,
    county: a.county ?? null,
    postcode: a.postcode ?? null,
    state: a.state ?? null,
    state_district: a.state_district ?? null,
    country: a.country ?? null,
    lat,
    lng,
    raw_json: r as unknown as Json,
  }

  // Dedupe on the OSM natural key when present; otherwise just insert.
  if (osmId != null) {
    const rows = await db
      .insert(address)
      .values(values)
      .onConflictDoUpdate({
        target: [address.user_id, address.osm_id, address.osm_type],
        targetWhere: sql`osm_id is not null`,
        set: { display_name: values.display_name },
      })
      .returning({ id: address.id })
    return rows[0]?.id ?? null
  }
  const rows = await db.insert(address).values(values).returning({ id: address.id })
  return rows[0]?.id ?? null
}

/** Look up an already-cached address near a point (within ~30 m), no network. */
export async function cachedAddressNear(
  db: Db,
  userId: string,
  lat: number,
  lng: number,
): Promise<number | null> {
  // ~30 m in degrees latitude ≈ 0.00027; good enough to reuse a recent fix.
  const eps = 0.0003
  const rows = await db
    .select({ id: address.id })
    .from(address)
    .where(
      and(
        eq(address.user_id, userId),
        sql`abs(${address.lat} - ${lat}) < ${eps}`,
        sql`abs(${address.lng} - ${lng}) < ${eps}`,
      ),
    )
    .limit(1)
  return rows[0]?.id ?? null
}
