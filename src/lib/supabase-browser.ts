/**
 * Browser-side Supabase client (for dashboard login via Supabase Auth).
 * Uses the PUBLIC url + anon key — these are safe to ship to the client, so they
 * carry the VITE_ prefix. The anon key is RLS-gated; never put the service-role
 * key here. @supabase/ssr stores the session in cookies so the server can read it.
 */
import { createBrowserClient } from '@supabase/ssr'

let client: ReturnType<typeof createBrowserClient> | null = null

export function getSupabaseBrowser() {
  if (client) return client
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!url || !anonKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Add them to .env (see .env.example).',
    )
  }
  client = createBrowserClient(url, anonKey)
  return client
}
