/**
 * Tesla OAuth 2.0 (Authorization Code + PKCE) and partner/region helpers.
 * All server-only. The third-party user token is used for every data read.
 */
import { createHash, randomBytes } from 'node:crypto'
import { serverEnv, TESLA_OAUTH, TESLA_SCOPES } from '../env'
import type { TeslaRegionResponse, TeslaTokenResponse } from './types'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function createState(): string {
  return base64url(randomBytes(16))
}

/** Build the Tesla authorize URL to redirect the user to. */
export function buildAuthorizeUrl(opts: { state: string; codeChallenge: string }): string {
  const { clientId, redirectUri, oauthAudience } = serverEnv.tesla()
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: TESLA_SCOPES.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    audience: oauthAudience,
  })
  return `${TESLA_OAUTH.authorize}?${params.toString()}`
}

/** Exchange an authorization code for the first access + refresh token. */
export async function exchangeCodeForToken(opts: {
  code: string
  codeVerifier: string
}): Promise<TeslaTokenResponse> {
  const { clientId, clientSecret, redirectUri, oauthAudience } = serverEnv.tesla()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: opts.code,
    redirect_uri: redirectUri,
    code_verifier: opts.codeVerifier,
    audience: oauthAudience,
  })
  return postToken(body)
}

/**
 * Refresh the access token. Tesla ROTATES the refresh token on every call —
 * the caller MUST persist the returned refresh_token atomically and discard the
 * old one, or the chain breaks and the user must re-link.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TeslaTokenResponse> {
  const { clientId } = serverEnv.tesla()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  })
  return postToken(body)
}

/** Partner authentication token (client_credentials) for onboarding/admin. */
export async function getPartnerToken(): Promise<TeslaTokenResponse> {
  const { clientId, clientSecret, oauthAudience } = serverEnv.tesla()
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: TESLA_SCOPES.join(' '),
    audience: oauthAudience,
  })
  return postToken(body)
}

/** Discover the vehicle's region + correct Fleet API base URL. */
export async function getUserRegion(accessToken: string, baseUrl: string): Promise<TeslaRegionResponse> {
  const res = await fetch(`${baseUrl}/api/1/users/region`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new Error(`users/region failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as TeslaRegionResponse
}

async function postToken(body: URLSearchParams): Promise<TeslaTokenResponse> {
  const res = await fetch(TESLA_OAUTH.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new Error(`Tesla token endpoint failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as TeslaTokenResponse
}
