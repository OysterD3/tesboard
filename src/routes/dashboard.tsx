import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getAuthStatus } from '../functions/account.functions'
import { getDashboardData } from '../functions/dashboard-data.functions'
import { DashboardProvider, useDash } from '../components/dashboard/DashboardProvider'
import { Icon, Card } from '../components/dashboard/primitives'
import { ICON, SECTION, themeVars } from '../components/dashboard/theme'

interface DashSearch {
  vin?: string
  tesla_error?: string
  tesla_linked?: string
}

export const Route = createFileRoute('/dashboard')({
  validateSearch: (search: Record<string, unknown>): DashSearch => ({
    vin: typeof search.vin === 'string' ? search.vin : undefined,
    tesla_error: typeof search.tesla_error === 'string' ? search.tesla_error : undefined,
    tesla_linked: typeof search.tesla_linked === 'string' ? search.tesla_linked : undefined,
  }),
  beforeLoad: async () => {
    const status = await getAuthStatus()
    if (!status.authed) throw redirect({ to: '/login' })
    return { auth: status }
  },
  loaderDeps: ({ search }) => ({ vin: search.vin }),
  loader: async ({ context, deps }) => {
    const linked = context.auth.teslaLinked

    // ONE server fn → ONE database connection for the whole SSR render. (Calling
    // the ~12 reads as separate server fns opened ~12 connections in a single
    // Worker request and blew past Cloudflare's 6-connections-per-request limit →
    // "Network connection lost" on refresh. See dashboard-data.functions.ts.)
    // The active car is resolved server-side (requested vin if owned, else the
    // most-recently-active); `vin` stays out of the URL unless the user switches.
    const data = await getDashboardData({ data: { vin: deps.vin } })
    return {
      auth: context.auth,
      linked,
      ...data,
    }
  },
  component: () => (
    <DashboardProvider>
      <DashboardShell />
    </DashboardProvider>
  ),
})

const NAV = [
  { key: 'overview', to: '/dashboard', exact: true, label: 'Overview', icon: ICON.overview, bolt: false, color: '__accent__' },
  { key: 'drives', to: '/dashboard/drives', exact: false, label: 'Drives', icon: ICON.drives, bolt: false, color: SECTION.drives },
  { key: 'charging', to: '/dashboard/charging', exact: false, label: 'Charging', icon: ICON.charging, bolt: true, color: SECTION.charging },
  { key: 'insights', to: '/dashboard/insights', exact: false, label: 'Insights', icon: ICON.insights, bolt: false, color: SECTION.insights },
  { key: 'analytics', to: '/dashboard/analytics', exact: false, label: 'Analytics', icon: ICON.battery, bolt: false, color: SECTION.analytics },
  { key: 'settings', to: '/dashboard/settings', exact: false, label: 'Settings', icon: ICON.settings, bolt: false, color: SECTION.settings },
] as const

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function DashboardShell() {
  const { linked, overview, activeVin } = Route.useLoaderData()
  const { theme, accent, toggleTheme } = useDash()
  const location = useLocation()
  const navigate = useNavigate()
  const td = 'var(--td,#86868b)'

  const vehicles = overview.vehicles
  const vw = vehicles.find((v) => v.vehicle.vin === activeVin) ?? vehicles[0]
  const vehicleName = vw?.vehicle.display_name || 'Your Tesla'
  const trim = vw?.vehicle.car_type || null
  const canSwitch = vehicles.length > 1

  const [pickerOpen, setPickerOpen] = useState(false)
  function selectVehicle(vin: string) {
    setPickerOpen(false)
    if (vin === activeVin) return
    navigate({ to: '.', search: (prev) => ({ ...prev, vin }), replace: true })
  }

  // Time-based greeting, computed after mount to avoid an SSR/clock mismatch.
  const [greeting, setGreeting] = useState('Welcome back')
  useEffect(() => setGreeting(greetingFor(new Date().getHours())), [])

  const search = location.search as { tesla_error?: string; tesla_linked?: string }

  return (
    <div
      style={{
        ...themeVars(theme, accent),
        background: 'var(--bg,#f5f5f7)',
        minHeight: '100vh',
        width: '100%',
        color: 'var(--tx,#1d1d1f)',
        fontFamily: "'Geist', system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 430,
          minHeight: '100vh',
          margin: '0 auto',
          position: 'relative',
          padding: '0 20px 124px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* HEADER */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '30px 2px 22px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, position: 'relative' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: td, whiteSpace: 'nowrap' }}>{greeting}</span>
            {canSwitch ? (
              <button
                onClick={() => setPickerOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', maxWidth: '100%' }}
              >
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--tx,#1d1d1f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vehicleName}</span>
                <Icon d={ICON.chevron} size={20} color={td} />
              </button>
            ) : (
              <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--tx,#1d1d1f)' }}>{vehicleName}</span>
            )}
            {trim && <span style={{ fontSize: 13, fontWeight: 500, color: td }}>{trim}</span>}

            {canSwitch && pickerOpen && (
              <>
                <div onClick={() => setPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div role="listbox" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 8, minWidth: 220, maxWidth: 280, background: 'var(--card,#fff)', border: '1px solid var(--border,rgba(0,0,0,0.08))', borderRadius: 16, boxShadow: 'var(--shadow)', padding: 6, zIndex: 31 }}>
                  {vehicles.map((v) => {
                    const isActive = v.vehicle.vin === activeVin
                    return (
                      <button
                        key={v.vehicle.vin}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => selectVehicle(v.vehicle.vin)}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer', background: isActive ? 'var(--track,#f0f0f3)' : 'transparent', borderRadius: 11, padding: '10px 12px' }}
                      >
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx,#1d1d1f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.vehicle.display_name || 'Tesla'}</span>
                          {v.vehicle.car_type && <span style={{ fontSize: 11, fontWeight: 500, color: td }}>{v.vehicle.car_type}</span>}
                        </span>
                        {isActive && <Icon d={ICON.check} size={16} color={accent} />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{
              width: 42,
              height: 42,
              border: '1px solid var(--border,rgba(0,0,0,0.08))',
              cursor: 'pointer',
              borderRadius: '50%',
              background: 'var(--card,#fff)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
              marginTop: 4,
            }}
          >
            <Icon d={theme === 'dark' ? ICON.sun : ICON.moon} size={19} color="var(--tx,#1d1d1f)" width={1.8} />
          </button>
        </div>

        {/* Tesla link status / banners */}
        {search.tesla_error && (
          <Banner tone="error" title="Couldn’t link your Tesla account" body={search.tesla_error} />
        )}
        {search.tesla_linked === '1' && (
          <Banner tone="ok" title="Tesla account linked" body="The poller will start collecting data shortly." />
        )}
        {!linked && (
          <Card radius={18} style={{ marginBottom: 14, padding: '16px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx,#1d1d1f)' }}>
              Tesla account not linked — connect it to start collecting data.
            </span>
            <a
              href="/api/auth/tesla/login"
              style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: accent, borderRadius: 30, padding: '8px 16px', textDecoration: 'none', whiteSpace: 'nowrap' }}
            >
              Link Tesla
            </a>
          </Card>
        )}

        <Outlet />

        {/* BOTTOM NAV */}
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 16,
            width: 'calc(100% - 32px)',
            maxWidth: 402,
            background: 'var(--nav-bg,rgba(255,255,255,0.82))',
            backdropFilter: 'saturate(180%) blur(20px)',
            WebkitBackdropFilter: 'saturate(180%) blur(20px)',
            border: '1px solid var(--border,rgba(0,0,0,0.08))',
            borderRadius: 22,
            boxShadow: 'var(--shadow)',
            padding: '9px 2px',
            display: 'flex',
            justifyContent: 'space-around',
            zIndex: 20,
          }}
        >
          {NAV.map((n) => {
            const active = n.exact
              ? location.pathname === n.to || location.pathname === n.to + '/'
              : location.pathname.startsWith(n.to) ||
                // The Battery-health drill-in lives at /dashboard/battery but
                // belongs to the Analytics tab.
                (n.key === 'analytics' && location.pathname.startsWith('/dashboard/battery'))
            const color = n.color === '__accent__' ? accent : n.color
            const tint = active ? color : td
            return (
              <Link
                key={n.key}
                to={n.to}
                search={(prev) => prev}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 2px',
                  flex: 1,
                  textDecoration: 'none',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24 }}>
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill={n.bolt ? tint : 'none'}
                    stroke={n.bolt ? 'none' : tint}
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={n.icon} />
                  </svg>
                </span>
                <span style={{ fontSize: 10, fontWeight: active ? 600 : 500, letterSpacing: '0.01em', color: tint }}>
                  {n.label}
                </span>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Banner({ tone, title, body }: { tone: 'error' | 'ok'; title: string; body: string }) {
  const c = tone === 'error' ? '#f43f5e' : '#34c759'
  return (
    <Card radius={18} style={{ marginBottom: 14, padding: '14px 16px', borderColor: 'rgba(0,0,0,0)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, marginTop: 6, flex: 'none' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx,#1d1d1f)' }}>{title}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--td,#86868b)', overflowWrap: 'anywhere' }}>{body}</span>
        </div>
      </div>
    </Card>
  )
}
