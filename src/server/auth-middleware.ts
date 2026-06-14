/**
 * Server-function auth middleware.
 *
 * IMPORTANT: server functions are independently-reachable RPC endpoints. Route
 * `beforeLoad` guards are UX-only and do NOT protect them. Every data server fn
 * must carry this middleware so the handler runs only for an authenticated user,
 * and all queries are scoped to `context.userId`.
 */
import { createMiddleware } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { getAuthClient } from './db.server'

export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    // Validate the session here; data fns then scope every Drizzle query to
    // context.userId. (Server context stays server-side.)
    const supabase = getAuthClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) {
      throw redirect({ to: '/login' })
    }
    return next({
      context: {
        userId: data.user.id,
        userEmail: data.user.email ?? null,
      },
    })
  },
)
