import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { getSupabaseBrowser } from '../lib/supabase-browser'
import { getAuthStatus } from '../functions/account.functions'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const status = await getAuthStatus()
    if (status.authed) throw redirect({ to: '/dashboard' })
  },
  component: LoginPage,
})

// Single-user app: there is no public sign-up. The one account is provisioned
// out of band (see `pnpm user:create`); this page only signs in.
function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { error } = await getSupabaseBrowser().auth.signInWithPassword({
        email,
        password,
      })
      if (error) throw error
      await router.navigate({ to: '/dashboard' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in mx-auto max-w-md rounded-[2rem] px-6 py-10 sm:px-10">
        <p className="island-kicker mb-3">tesboard</p>
        <h1 className="display-title mb-5 text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
          Sign in
        </h1>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-sm font-semibold text-[var(--sea-ink-soft)]">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white/60 px-3 py-2 text-[var(--sea-ink)] outline-none focus:border-[var(--lagoon-deep)]"
            />
          </label>
          <label className="text-sm font-semibold text-[var(--sea-ink-soft)]">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white/60 px-3 py-2 text-[var(--sea-ink)] outline-none focus:border-[var(--lagoon-deep)]"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-full bg-[var(--lagoon-deep)] px-5 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  )
}
