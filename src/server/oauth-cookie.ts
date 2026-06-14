/**
 * Short-lived, HttpOnly cookie that carries the OAuth `state` + PKCE verifier
 * between the login redirect and the callback. Secure is set only when the app
 * origin is HTTPS so local http://localhost dev still works.
 */
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import { serverEnv } from './env'

const COOKIE = 'tesla_oauth'

export interface OAuthState {
  state: string
  verifier: string
  /** Supabase user id that initiated the flow; the callback must match it. */
  uid: string
}

export function setOAuthCookie(value: OAuthState): void {
  const secure = serverEnv.app().origin.startsWith('https://')
  setCookie(COOKIE, JSON.stringify(value), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })
}

export function readOAuthCookie(): OAuthState | null {
  const raw = getCookie(COOKIE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthState
  } catch {
    return null
  }
}

export function clearOAuthCookie(): void {
  deleteCookie(COOKIE, { path: '/' })
}
