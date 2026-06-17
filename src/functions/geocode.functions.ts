/**
 * On-demand reverse-geocode backfill — turns the lat/lng the poller stores on
 * drives/charges into named places (`address` rows), so live rows show "A → B"
 * like the TeslaMate-imported ones instead of a timestamp.
 *
 * Kept OFF the 2-min cron (Nominatim allows ~1 req/s); the dashboard calls this
 * in a loop until `remaining` is 0. Each call resolves already-cached points for
 * free (`cachedAddressNear`, no network) and geocodes at most MAX_NETWORK NEW
 * places (throttled ≥1s apart) — so once "home" is geocoded once, every other
 * home endpoint links from cache without another network hit.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { authMiddleware } from '../server/auth-middleware'
import { withDb, type Db } from '../server/db'
import { chargeSession, driveSession } from '../server/schema'
import { cachedAddressNear, findOrCreateAddress } from '../server/geocode'

const MAX_NETWORK = 8 // Nominatim calls per invocation (≥1s apart ⇒ ~9s wall)
const NETWORK_GAP_MS = 1100
const SCAN_PER_KIND = 150 // newest-first window scanned per call

type Kind = 'drive_start' | 'drive_end' | 'charge'
interface Endpoint {
  kind: Kind
  id: number
  lat: number
  lng: number
}

export interface BackfillResult {
  /** Endpoints linked to an address this run (cache hits + new geocodes). */
  linked: number
  /** Nominatim network calls made this run. */
  networkCalls: number
  /** Endpoints still un-geocoded after this run (drive starts + ends + charges). */
  remaining: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const backfillAddresses = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<BackfillResult> =>
    withDb(async (db) => {
      const userId = context.userId
      const endpoints = await collectEndpoints(db, userId)

      let linked = 0
      let networkCalls = 0
      for (const ep of endpoints) {
        // Free path: reuse an already-cached address within ~30 m.
        let addrId = await cachedAddressNear(db, userId, ep.lat, ep.lng)
        if (addrId == null) {
          if (networkCalls >= MAX_NETWORK) continue // leave the rest for the next call
          if (networkCalls > 0) await sleep(NETWORK_GAP_MS)
          addrId = await findOrCreateAddress(db, userId, ep.lat, ep.lng)
          networkCalls++
          if (addrId == null) continue // geocoding failed — try again next run
        }
        await linkEndpoint(db, userId, ep, addrId)
        linked++
      }

      const remaining = await countRemaining(db, userId)
      return { linked, networkCalls, remaining }
    }),
  )

async function collectEndpoints(db: Db, userId: string): Promise<Endpoint[]> {
  const [starts, ends, charges] = await Promise.all([
    db
      .select({ id: driveSession.id, lat: driveSession.start_lat, lng: driveSession.start_lng })
      .from(driveSession)
      .where(
        and(eq(driveSession.user_id, userId), isNull(driveSession.start_address_id), isNotNull(driveSession.start_lat)),
      )
      .orderBy(desc(driveSession.started_at))
      .limit(SCAN_PER_KIND),
    db
      .select({ id: driveSession.id, lat: driveSession.end_lat, lng: driveSession.end_lng })
      .from(driveSession)
      .where(
        and(eq(driveSession.user_id, userId), isNull(driveSession.end_address_id), isNotNull(driveSession.end_lat)),
      )
      .orderBy(desc(driveSession.started_at))
      .limit(SCAN_PER_KIND),
    db
      .select({ id: chargeSession.id, lat: chargeSession.lat, lng: chargeSession.lng })
      .from(chargeSession)
      .where(and(eq(chargeSession.user_id, userId), isNull(chargeSession.address_id), isNotNull(chargeSession.lat)))
      .orderBy(desc(chargeSession.started_at))
      .limit(SCAN_PER_KIND),
  ])

  const out: Endpoint[] = []
  for (const r of starts) if (r.lat != null && r.lng != null) out.push({ kind: 'drive_start', id: r.id, lat: r.lat, lng: r.lng })
  for (const r of ends) if (r.lat != null && r.lng != null) out.push({ kind: 'drive_end', id: r.id, lat: r.lat, lng: r.lng })
  for (const r of charges) if (r.lat != null && r.lng != null) out.push({ kind: 'charge', id: r.id, lat: r.lat, lng: r.lng })
  return out
}

async function linkEndpoint(db: Db, userId: string, ep: Endpoint, addrId: number): Promise<void> {
  if (ep.kind === 'charge') {
    await db
      .update(chargeSession)
      .set({ address_id: addrId })
      .where(and(eq(chargeSession.id, ep.id), eq(chargeSession.user_id, userId)))
  } else if (ep.kind === 'drive_start') {
    await db
      .update(driveSession)
      .set({ start_address_id: addrId })
      .where(and(eq(driveSession.id, ep.id), eq(driveSession.user_id, userId)))
  } else {
    await db
      .update(driveSession)
      .set({ end_address_id: addrId })
      .where(and(eq(driveSession.id, ep.id), eq(driveSession.user_id, userId)))
  }
}

async function countRemaining(db: Db, userId: string): Promise<number> {
  const [a, b, c] = await Promise.all([
    db
      .select({ c: count() })
      .from(driveSession)
      .where(
        and(eq(driveSession.user_id, userId), isNull(driveSession.start_address_id), isNotNull(driveSession.start_lat)),
      ),
    db
      .select({ c: count() })
      .from(driveSession)
      .where(
        and(eq(driveSession.user_id, userId), isNull(driveSession.end_address_id), isNotNull(driveSession.end_lat)),
      ),
    db
      .select({ c: count() })
      .from(chargeSession)
      .where(and(eq(chargeSession.user_id, userId), isNull(chargeSession.address_id), isNotNull(chargeSession.lat))),
  ])
  return (a[0]?.c ?? 0) + (b[0]?.c ?? 0) + (c[0]?.c ?? 0)
}
