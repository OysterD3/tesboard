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
import { dashboardQuery, useDashboardData } from '../lib/queries'
import { DashboardProvider, useDash } from '../components/dashboard/DashboardProvider'
import { Icon, Card } from '../components/dashboard/primitives'
import { ICON, SECTION, THEME, themeVars } from '../components/dashboard/theme'
import { cn } from '../lib/utils'

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
    // Prefetch the aggregate into the react-query cache (one server fn → one DB
    // connection, still under Cloudflare's 6-conns/request limit; see
    // dashboard-data.functions.ts). Child routes + this shell read the SAME query
    // via useDashboardData() (cache hit), so a mutation can invalidate
    // ['dashboard'] and the whole view refreshes. The active car is resolved
    // server-side; `vin` stays out of the URL unless the user switches.
    await context.queryClient.ensureQueryData(dashboardQuery(deps.vin))
    return { auth: context.auth, linked: context.auth.teslaLinked }
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
  { key: 'idles', to: '/dashboard/idles', exact: false, label: 'Idles', icon: ICON.parking, bolt: false, color: SECTION.idles },
  { key: 'analytics', to: '/dashboard/analytics', exact: false, label: 'Analytics', icon: ICON.battery, bolt: false, color: SECTION.analytics },
  { key: 'settings', to: '/dashboard/settings', exact: false, label: 'Settings', icon: ICON.settings, bolt: false, color: SECTION.settings },
] as const

function greetingFor(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function DashboardShell() {
  const { linked } = Route.useLoaderData()
  const { overview, activeVin } = useDashboardData()
  const { theme, accent, toggleTheme } = useDash()
  const location = useLocation()
  const navigate = useNavigate()
  const td = THEME.td

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
      <div className="w-full max-w-[430px] min-h-screen mx-auto relative px-5 pt-0 pb-[124px] flex flex-col">
        {/* HEADER */}
        <div className="flex items-start justify-between pt-[30px] px-0.5 pb-[22px]">
          <div className="flex flex-col gap-1 min-w-0 relative">
            <span className="text-[13px] font-medium text-muted-foreground whitespace-nowrap">{greeting}</span>
            {canSwitch ? (
              <button
                onClick={() => setPickerOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
                className="flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer max-w-full"
              >
                <span className="text-[28px] font-bold tracking-[-0.025em] text-foreground overflow-hidden text-ellipsis whitespace-nowrap">{vehicleName}</span>
                <Icon d={ICON.chevron} size={20} color={td} />
              </button>
            ) : (
              <span className="text-[28px] font-bold tracking-[-0.025em] text-foreground">{vehicleName}</span>
            )}
            {trim && <span className="text-[13px] font-medium text-muted-foreground">{trim}</span>}

            {canSwitch && pickerOpen && (
              <>
                <div onClick={() => setPickerOpen(false)} className="fixed inset-0 z-30" />
                <div role="listbox" className="absolute top-full left-0 mt-2 min-w-[220px] max-w-[280px] bg-card border border-border rounded-2xl shadow-[var(--shadow)] p-1.5 z-[31]">
                  {vehicles.map((v) => {
                    const isActive = v.vehicle.vin === activeVin
                    return (
                      <button
                        key={v.vehicle.vin}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => selectVehicle(v.vehicle.vin)}
                        className={cn('flex items-center justify-between gap-2.5 w-full text-left border-none cursor-pointer rounded-[11px] px-3 py-2.5', isActive ? 'bg-secondary' : 'bg-transparent')}
                      >
                        <span className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-[14px] font-semibold text-foreground overflow-hidden text-ellipsis whitespace-nowrap">{v.vehicle.display_name || 'Tesla'}</span>
                          {v.vehicle.car_type && <span className="text-[11px] font-medium text-muted-foreground">{v.vehicle.car_type}</span>}
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
            className="w-[42px] h-[42px] border border-border cursor-pointer rounded-full bg-card flex items-center justify-center flex-none mt-1"
          >
            <Icon d={theme === 'dark' ? ICON.sun : ICON.moon} size={19} color={THEME.tx} width={1.8} />
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
          <Card radius={18} className="mb-[14px] px-[18px] py-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] font-semibold text-foreground">
              Tesla account not linked — connect it to start collecting data.
            </span>
            <a
              href="/api/auth/tesla/login"
              className="text-[13px] font-semibold text-primary-foreground bg-primary rounded-[30px] px-4 py-2 no-underline whitespace-nowrap"
            >
              Link Tesla
            </a>
          </Card>
        )}

        <Outlet />

        {/* BOTTOM NAV */}
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-4 w-[calc(100%-32px)] max-w-[402px] bg-[var(--nav-bg,rgba(255,255,255,0.82))] border border-border rounded-[22px] shadow-[var(--shadow)] py-[9px] px-0.5 flex justify-around z-20"
          // No clean Tailwind util emits the -webkit- prefix needed for the
          // frosted-glass nav on iOS Safari, so keep both backdrop filters inline.
          style={{
            backdropFilter: 'saturate(180%) blur(20px)',
            WebkitBackdropFilter: 'saturate(180%) blur(20px)',
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
                className="border-none bg-transparent cursor-pointer flex flex-col items-center gap-[5px] py-[5px] px-0.5 flex-1 no-underline"
              >
                <span className="flex items-center justify-center h-6">
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
                <span className={cn('text-[10px] tracking-[0.01em]', active ? 'font-semibold' : 'font-medium')} style={{ color: tint }}>
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
    <Card radius={18} className="mb-[14px] px-4 py-[14px] border-transparent">
      <div className="flex gap-3 items-start">
        <span className="w-2 h-2 rounded-full mt-1.5 flex-none" style={{ background: c }} />
        <div className="flex flex-col gap-[3px]">
          <span className="text-[13px] font-semibold text-foreground">{title}</span>
          <span className="text-[12px] font-medium text-muted-foreground [overflow-wrap:anywhere]">{body}</span>
        </div>
      </div>
    </Card>
  )
}
