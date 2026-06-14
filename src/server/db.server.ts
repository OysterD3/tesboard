/**
 * Supabase Auth client (server-only).
 *
 * Auth is the ONLY thing Supabase's client library does here now — it validates
 * the request's session cookie / JWT against Supabase Auth (GoTrue). All DATA
 * access goes through Drizzle (see ./db). The `.server.ts` suffix guarantees this
 * module is never bundled to the client.
 */
import { createServerClient } from '@supabase/ssr'
import { getCookies, setCookie } from '@tanstack/react-start/server'
import { serverEnv } from './env'

/** Request-scoped Supabase client, bound to the auth cookies. Auth use only. */
export function getAuthClient() {
  const { url, anonKey } = serverEnv.supabase()
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        const all = getCookies() ?? {}
        return Object.entries(all).map(([name, value]) => ({
          name,
          value: value ?? '',
        }))
      },
      setAll(cookies) {
        for (const { name, value, options } of cookies) {
          setCookie(name, value, options)
        }
      },
    },
  })
}

/** Returns the authenticated Supabase user for this request, or null. */
export async function getSessionUser() {
  const supabase = getAuthClient()
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user
}
