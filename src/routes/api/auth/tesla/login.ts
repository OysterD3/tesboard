/**
 * GET /api/auth/tesla/login
 * Starts the Tesla OAuth flow: generate state + PKCE, stash them in a one-shot
 * cookie, and redirect the browser to Tesla's authorize page. The user must
 * already be signed into the dashboard (Supabase Auth) so the callback can link
 * the Tesla account to their user id.
 */
import { createFileRoute } from '@tanstack/react-router'
import { buildAuthorizeUrl, createPkcePair, createState } from '../../../../server/tesla/oauth'
import { setOAuthCookie } from '../../../../server/oauth-cookie'
import { getSessionUser } from '../../../../server/db.server'
import { serverEnv } from '../../../../server/env'

export const Route = createFileRoute('/api/auth/tesla/login')({
  server: {
    handlers: {
      GET: async () => {
        const user = await getSessionUser()
        if (!user) {
          return redirectTo('/login')
        }
        const { state, verifier, challenge } = {
          state: createState(),
          ...createPkcePair(),
        }
        setOAuthCookie({ state, verifier, uid: user.id })
        return redirectTo(buildAuthorizeUrl({ state, codeChallenge: challenge }))
      },
    },
  },
})

function redirectTo(location: string): Response {
  // Absolute or relative both work; relative is resolved against the app origin.
  const url = location.startsWith('http')
    ? location
    : `${serverEnv.app().origin}${location}`
  return new Response(null, { status: 302, headers: { Location: url } })
}
