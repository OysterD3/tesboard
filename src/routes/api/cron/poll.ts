/**
 * POST /api/cron/poll  (Authorization: Bearer <CRON_TRIGGER_SECRET>)
 * Trigger one poll cycle. Call this from your scheduler (Supabase pg_cron +
 * edge function, or an external cron) on the adaptive cadence. Pass
 * ?reconcile=1 to also pull Tesla's Supercharger billing history.
 *
 * The TanStack app is request/response — it does not poll on its own. This route
 * is the scheduler's entry point. Guarded by a shared secret (constant-time).
 */
import { createFileRoute } from '@tanstack/react-router'
import { getRequestHeader, getRequestUrl } from '@tanstack/react-start/server'
import { timingSafeEqual } from 'node:crypto'
import { runPollCycle } from '../../../server/poller'
import { reconcileAllUsers } from '../../../server/reconcile'
import { serverEnv } from '../../../server/env'

function authorized(): boolean {
  const header = getRequestHeader('authorization') ?? ''
  const presented = header.replace(/^Bearer\s+/i, '')
  const expected = serverEnv.app().cronTriggerSecret
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const Route = createFileRoute('/api/cron/poll')({
  server: {
    handlers: {
      POST: async () => {
        if (!authorized()) {
          return new Response('Unauthorized', { status: 401 })
        }
        const url = getRequestUrl()
        const poll = await runPollCycle()
        const reconcile = url.searchParams.get('reconcile')
          ? await reconcileAllUsers()
          : null
        return Response.json({ ok: true, poll, reconcile })
      },
    },
  },
})
