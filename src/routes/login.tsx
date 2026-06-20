import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getSupabaseBrowser } from '../lib/supabase-browser'
import { getAuthStatus } from '../functions/account.functions'
import { DEFAULT_ACCENT, type ThemeName, themeVars } from '../components/dashboard/theme'
import { cn } from '../lib/utils'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const status = await getAuthStatus()
    if (status.authed) throw redirect({ to: '/dashboard' })
  },
  component: LoginPage,
})

const ACCENT = DEFAULT_ACCENT

// Single-user app: there is no public sign-up. The one account is provisioned
// out of band (see `pnpm user:create`); this page only signs in. Styled to match
// the dashboard's design system (same theme tokens + dark-mode handling).
function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The root init script already set the .dark/.light class on <html>; mirror it
  // into the dashboard theme tokens after mount (default light for SSR).
  const [theme, setTheme] = useState<ThemeName>('light')
  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  }, [])

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

  const inputCls =
    'mt-1.5 w-full rounded-xl border border-border bg-secondary px-[13px] py-[11px] text-[15px] text-foreground outline-none focus:border-ring'

  return (
    <div
      suppressHydrationWarning
      // The themeVars() spread MUST stay inline — it injects the runtime --bg/
      // --card/--tx/--td/--border/--ac vars this page's bridge classes resolve
      // against (this page is outside DashboardProvider). Geist is a one-off here.
      style={{ ...themeVars(theme, ACCENT), fontFamily: "'Geist', system-ui, -apple-system, sans-serif" }}
      className="flex min-h-screen w-full items-center justify-center bg-background px-5 py-6 text-foreground"
    >
      <div className="w-full max-w-[380px]">
        <div className="mb-[22px] flex items-center justify-center gap-[9px]">
          <span className="size-2.5 flex-none rounded-full bg-primary" />
          <span className="text-sm font-semibold tracking-[-0.01em] text-muted-foreground">tesboard</span>
        </div>

        <div className="rounded-3xl border border-border bg-card px-6 pt-7 pb-[26px] shadow-[var(--shadow)]">
          <h1 className="m-0 text-2xl font-bold tracking-[-0.02em] text-foreground">Sign in</h1>
          <p className="mt-1.5 mb-[22px] text-sm font-medium text-muted-foreground">
            Your personal Tesla dashboard.
          </p>

          <form onSubmit={submit} className="flex flex-col gap-4">
            <label className="text-[13px] font-semibold text-muted-foreground">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
              />
            </label>
            <label className="text-[13px] font-semibold text-muted-foreground">
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            </label>

            {error && (
              <p className="m-0 text-[13px] font-medium text-destructive [overflow-wrap:anywhere]">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className={cn(
                'mt-1 rounded-[30px] border-none bg-primary px-[18px] py-3 text-[15px] font-semibold text-primary-foreground transition-opacity duration-[120ms]',
                busy ? 'cursor-default opacity-60' : 'cursor-pointer opacity-100',
              )}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
