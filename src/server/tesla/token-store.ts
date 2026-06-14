/**
 * Persistence for Tesla OAuth tokens (encrypted at rest) + valid-access-token
 * retrieval with rotation. Uses the Drizzle client (owner connection); every
 * query is scoped by user_id.
 *
 * Rotation is the danger zone: Tesla rotates the refresh token on every use and
 * invalidates the old one. We defend with (a) an in-process single-flight per
 * user so overlapping callers share one refresh, and (b) an optimistic
 * compare-and-swap on the stored ciphertext so a losing concurrent writer does
 * not clobber the winner's rotated token.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { teslaToken } from '../schema'
import { decryptToken, encryptToken } from './crypto'
import { refreshAccessToken } from './oauth'
import type { TeslaTokenResponse } from './types'

const REFRESH_SKEW_MS = 60_000 // refresh a minute early to avoid edge-of-expiry 401s

/** In-process single-flight: collapse concurrent refreshes for the same user. */
const inflight = new Map<string, Promise<string>>()

export interface StoredToken {
  accessToken: string
  refreshToken: string
  refreshTokenEnc: string
  expiresAt: Date
  scope: string | null
}

/**
 * Persist a fresh token set (initial link). For the initial authorization-code
 * exchange the refresh token is always present, so a plain upsert is correct.
 */
export async function saveToken(
  db: Db,
  userId: string,
  token: TeslaTokenResponse,
): Promise<void> {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000)
  // Tesla may omit refresh_token/scope on a refresh — never overwrite the stored
  // refresh token with undefined (that would destroy the only copy). On the
  // initial link both are present.
  const refreshEnc = token.refresh_token ? encryptToken(token.refresh_token) : undefined
  const accessEnc = encryptToken(token.access_token)
  const expiresIso = expiresAt.toISOString()
  const nowIso = new Date().toISOString()

  const set: Record<string, unknown> = {
    access_token_enc: accessEnc,
    access_token_expires_at: expiresIso,
    updated_at: nowIso,
  }
  if (refreshEnc) set.refresh_token_enc = refreshEnc
  if (token.scope != null) set.scope = token.scope

  await db
    .insert(teslaToken)
    .values({
      user_id: userId,
      access_token_enc: accessEnc,
      // NOT NULL columns — guaranteed present on the initial exchange.
      refresh_token_enc: refreshEnc ?? '',
      access_token_expires_at: expiresIso,
      scope: token.scope ?? null,
      updated_at: nowIso,
    })
    .onConflictDoUpdate({ target: teslaToken.user_id, set })
}

async function readToken(db: Db, userId: string): Promise<StoredToken | null> {
  const rows = await db
    .select({
      access_token_enc: teslaToken.access_token_enc,
      refresh_token_enc: teslaToken.refresh_token_enc,
      access_token_expires_at: teslaToken.access_token_expires_at,
      scope: teslaToken.scope,
    })
    .from(teslaToken)
    .where(eq(teslaToken.user_id, userId))
    .limit(1)
  const data = rows[0]
  if (!data) return null
  return {
    accessToken: decryptToken(data.access_token_enc),
    refreshToken: decryptToken(data.refresh_token_enc),
    refreshTokenEnc: data.refresh_token_enc,
    expiresAt: new Date(data.access_token_expires_at),
    scope: data.scope,
  }
}

/**
 * Return a valid access token, refreshing when near expiry (or when forced, e.g.
 * after a 401). Concurrency-safe within a process via single-flight; across
 * processes via compare-and-swap on the old ciphertext.
 */
export async function getValidAccessToken(
  db: Db,
  userId: string,
  forceRefresh = false,
): Promise<string> {
  const stored = await readToken(db, userId)
  if (!stored) {
    throw new Error('No Tesla token on file for this user — link a Tesla account first.')
  }
  if (!forceRefresh && stored.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
    return stored.accessToken
  }

  const existing = inflight.get(userId)
  if (existing) return existing

  const promise = doRefresh(db, userId, stored).finally(() => inflight.delete(userId))
  inflight.set(userId, promise)
  return promise
}

async function doRefresh(db: Db, userId: string, stored: StoredToken): Promise<string> {
  const refreshed = await refreshAccessToken(stored.refreshToken)
  const newRefreshEnc = refreshed.refresh_token
    ? encryptToken(refreshed.refresh_token)
    : stored.refreshTokenEnc
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000)

  // Compare-and-swap: only the writer holding the ciphertext we refreshed from
  // wins. A loser (another process already rotated) updates 0 rows; we then
  // re-read and return the freshly stored access token.
  const updated = await db
    .update(teslaToken)
    .set({
      access_token_enc: encryptToken(refreshed.access_token),
      refresh_token_enc: newRefreshEnc,
      access_token_expires_at: expiresAt.toISOString(),
      scope: refreshed.scope ?? stored.scope,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(teslaToken.user_id, userId),
        eq(teslaToken.refresh_token_enc, stored.refreshTokenEnc),
      ),
    )
    .returning({ access_token_enc: teslaToken.access_token_enc })

  if (updated.length === 1) return refreshed.access_token

  // Lost the CAS — another writer rotated first. Use whatever is now stored.
  const current = await readToken(db, userId)
  if (!current) throw new Error('Tesla token vanished during refresh.')
  return current.accessToken
}
