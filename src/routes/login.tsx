import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getSupabaseBrowser } from '../lib/supabase-browser'
import { getAuthStatus } from '../functions/account.functions'
import { DEFAULT_ACCENT, type ThemeName, themeVars } from '../components/dashboard/theme'

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

  const TX = 'var(--tx,#1d1d1f)'
  const TD = 'var(--td,#86868b)'
  const inputStyle: React.CSSProperties = {
    marginTop: 6,
    width: '100%',
    borderRadius: 12,
    border: '1px solid var(--border,rgba(0,0,0,0.07))',
    background: 'var(--track,#f0f0f3)',
    padding: '11px 13px',
    fontSize: 15,
    color: TX,
    outline: 'none',
  }

  return (
    <div
      suppressHydrationWarning
      style={{
        ...themeVars(theme, ACCENT),
        background: 'var(--bg,#f5f5f7)',
        minHeight: '100vh',
        width: '100%',
        color: TX,
        fontFamily: "'Geist', system-ui, -apple-system, sans-serif",
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22, justifyContent: 'center' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: ACCENT, flex: 'none' }} />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: TD }}>tesboard</span>
        </div>

        <div
          style={{
            background: 'var(--card,#fff)',
            border: '1px solid var(--border,rgba(0,0,0,0.07))',
            borderRadius: 24,
            boxShadow: 'var(--shadow)',
            padding: '28px 24px 26px',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>Sign in</h1>
          <p style={{ margin: '6px 0 22px', fontSize: 14, fontWeight: 500, color: TD }}>
            Your personal Tesla dashboard.
          </p>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: TD }}>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
                onFocus={(e) => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border,rgba(0,0,0,0.07))')}
              />
            </label>
            <label style={{ fontSize: 13, fontWeight: 600, color: TD }}>
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
                onFocus={(e) => (e.currentTarget.style.borderColor = ACCENT)}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border,rgba(0,0,0,0.07))')}
              />
            </label>

            {error && (
              <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: '#f43f5e', overflowWrap: 'anywhere' }}>{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              style={{
                marginTop: 4,
                border: 'none',
                cursor: busy ? 'default' : 'pointer',
                borderRadius: 30,
                background: ACCENT,
                color: '#fff',
                fontSize: 15,
                fontWeight: 600,
                padding: '12px 18px',
                opacity: busy ? 0.6 : 1,
                transition: 'opacity 120ms',
              }}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
