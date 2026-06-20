import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { BatteryGlyph, EmptyCard, Icon, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import type { DriveVM } from '../../lib/dashboard-vm'
import type { Units } from '../../lib/units'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { LifetimeMap, MapMessage, MapOverlay, type MapPoint } from '../../components/dashboard/LifetimeMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { buildDrives } from '../../lib/dashboard-vm'
import { mergeNearbyPoints } from '../../lib/map-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthFilter, MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth, monthOptions } from '../../lib/month-group'
import { getDriveRoutes, type DriveRoutesMap } from '../../functions/drives.functions'
import { backfillAddresses } from '../../functions/geocode.functions'
import { backfillElevation } from '../../functions/elevation.functions'
import { backfillRouteMatch } from '../../functions/routematch.functions'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
]

function DrivesPage() {
  const { drives, activeVin } = dashApi.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()
  const all = buildDrives(drives, useDisplayTz())
  const months = monthOptions(all)
  const [month, setMonth] = useState('all')
  const visible = month === 'all' ? all : all.filter((d) => d.monthKey === month)
  const rows = groupByMonth(visible, (d) => d.id)
  const [view, setView] = useState<'history' | 'map'>('history')

  // Lifetime route map — every drive as its own GPS polyline. Lazy-loaded the
  // first time the Map tab is opened (and re-fetched if the active car changes).
  const fetchRoutes = useServerFn(getDriveRoutes)
  const [routesMap, setRoutesMap] = useState<DriveRoutesMap | null>(null)
  const [routesLoading, setRoutesLoading] = useState(false)

  // Drive start/end pins. Most routes share the same driveway / destination, so
  // the raw endpoints are merged by proximity (150m, same as the charge map) into
  // one pin per distinct place instead of hundreds of stacked dots; tapping zooms in.
  const drivePins = useMemo<MapPoint[]>(() => {
    if (!routesMap) return []
    const endpoints: [number, number][] = []
    for (const r of routesMap.routes) {
      if (r.length === 0) continue
      endpoints.push(r[0], r[r.length - 1])
    }
    return mergeNearbyPoints(endpoints).map((p) => ({ lat: p.lat, lng: p.lng }))
  }, [routesMap])

  useEffect(() => {
    if (view !== 'map' || routesMap) return
    let cancelled = false
    setRoutesLoading(true)
    fetchRoutes({ data: { vin: activeVin ?? undefined } })
      .then((r) => {
        if (!cancelled) setRoutesMap(r)
      })
      .catch(() => {
        if (!cancelled) setRoutesMap({ routes: [], driveCount: 0 })
      })
      .finally(() => {
        if (!cancelled) setRoutesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, routesMap, fetchRoutes, activeVin])

  // A car switch invalidates a cached route map.
  useEffect(() => {
    setRoutesMap(null)
  }, [activeVin])

  function open(id: string) {
    navigate({ to: '/dashboard/drives/$driveId', params: { driveId: id }, search: (prev) => prev })
  }

  if (all.length === 0) {
    return (
      <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ViewTitle>Drives</ViewTitle>
        <EmptyCard
          title="No drives recorded yet"
          body="Drives are built from polled snapshots (the Fleet API has no trip endpoint), so they start accruing once the poller is running and you take a drive."
        />
      </div>
    )
  }

  // Map view = a full-screen immersive map: the route map fills the whole
  // viewport, with the History/Map toggle, Snap-to-roads action, and the caption
  // floated over it.
  if (view === 'map') {
    const hasRoutes = !!routesMap && routesMap.routes.length > 0
    return (
      <MapOverlay
        topLeft={<Segmented options={VIEW_OPTIONS} value={view} onChange={setView} accent={COLOR} isDark={isDark} />}
        topRight={hasRoutes ? <SnapToRoadsButton isDark={isDark} onDone={() => setRoutesMap(null)} /> : null}
        caption={
          hasRoutes
            ? `${routesMap!.driveCount} route${routesMap!.driveCount === 1 ? '' : 's'} · ${drivePins.length} start/end place${drivePins.length === 1 ? '' : 's'} · road-matched (drives too GPS-sparse to snap are hidden)`
            : null
        }
      >
        {hasRoutes ? (
          <LifetimeMap fill routes={routesMap!.routes} points={drivePins} routeColor={COLOR} markerColor={COLOR} isDark={isDark} />
        ) : (
          <MapMessage>{routesLoading || !routesMap ? 'Building route map…' : 'No GPS routes recorded yet.'}</MapMessage>
        )}
      </MapOverlay>
    )
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Drives</ViewTitle>
        <Segmented options={VIEW_OPTIONS} value={view} onChange={setView} accent={COLOR} isDark={isDark} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <FillElevationButton isDark={isDark} />
        <ResolveLocationsButton isDark={isDark} />
      </div>

      <MonthFilter months={months} value={month} onChange={setMonth} color={COLOR} isDark={isDark} />

      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        estimateRowHeight={148}
        renderRow={(r) => {
          if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
          return <DriveCard d={r.item} u={u} onClick={() => open(r.item.id)} />
        }}
      />
    </div>
  )
}

/**
 * A drive history card in the Tessie "From → To" shape: a start endpoint (muted
 * pin) and an end endpoint (accent pin) joined by a dotted rail, each line a
 * place + state-of-charge + timestamp, then a divider and a distance / duration /
 * efficiency footer. The whole card navigates to the drive detail page.
 */
function DriveCard({ d, u, onClick }: { d: DriveVM; u: Units; onClick: () => void }) {
  const inProgress = d.endStamp == null
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'var(--card,#fff)',
        border: '1px solid var(--border,rgba(0,0,0,0.07))',
        borderRadius: 18,
        padding: '15px 16px',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color .2s ease, background .2s ease',
      }}
    >
      <Endpoint
        accent={TD}
        place={d.startPlace ?? 'Unknown location'}
        battery={d.startBattery}
        stamp={d.startStamp}
        connector
      />
      <Endpoint
        accent={COLOR}
        place={d.endPlace ?? (inProgress ? 'Drive in progress' : 'Unknown location')}
        battery={d.endBattery}
        stamp={d.endStamp}
      />

      <div style={{ borderTop: '1px solid var(--border,rgba(0,0,0,0.07))', margin: '13px 0 0', paddingTop: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>
          <Icon d={ICON.road} size={15} color={TD} />
          {fmtDist(u, d.distKm, 1)} {distUnit(u)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: TD }}>
          <Icon d={ICON.clock} size={15} color={TD} />
          {d.durMin} min
        </span>
        {d.effWhKm != null && (
          <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: TD }}>
            {effFromWhKm(u, d.effWhKm)} {effSuffix(u)}
          </span>
        )}
      </div>
    </button>
  )
}

/** One endpoint line of a DriveCard (pin + place + SOC/timestamp), optionally
 *  trailing the dotted rail down to the next endpoint. */
function Endpoint({
  accent,
  place,
  battery,
  stamp,
  connector = false,
}: {
  accent: string
  place: string
  battery: number | null
  stamp: string | null
  connector?: boolean
}) {
  const meta = [battery != null ? `${battery}%` : null, stamp].filter(Boolean) as string[]
  return (
    // Default align-items (stretch) lets the icon column match the (taller) text
    // column's height, so the flex:1 dotted rail spans the full gap to the next
    // pin — the same continuous-rail pattern the drive-detail Endpoint uses.
    <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
      <div style={{ width: 22, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Icon d={ICON.pin} size={20} color={accent} />
        {connector && (
          <span style={{ flex: 1, marginTop: 4, marginBottom: -2, minHeight: 16, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1, paddingBottom: connector ? 16 : 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {place}
        </span>
        {meta.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: TD, minWidth: 0, whiteSpace: 'nowrap' }}>
            {battery != null && <span style={{ flex: 'none', display: 'inline-flex' }}><BatteryGlyph pct={battery} color={TD} size={18} /></span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.join(' · ')}</span>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * On-demand elevation backfill. The Fleet API has no altitude, so this fills
 * `vehicle_snapshot.elevation_m` from the stored GPS via Open-Meteo, looping the
 * throttled `backfillElevation` until nothing's left, then invalidates the loader
 * so freshly-elevated drives light up their elevation chart. Teal to echo the
 * elevation chart accent.
 */
function FillElevationButton({ isDark }: { isDark: boolean }) {
  const ELEV = SECTION.insights
  const router = useRouter()
  const run = useServerFn(backfillElevation)
  const [st, setSt] = useState<{ running: boolean; filled: number; remaining: number | null; done: boolean }>({
    running: false,
    filled: 0,
    remaining: null,
    done: false,
  })

  async function resolve() {
    if (st.running) return
    setSt({ running: true, filled: 0, remaining: null, done: false })
    let filled = 0
    try {
      for (let i = 0; i < 80; i++) {
        const r = await run()
        filled += r.filled
        setSt({ running: true, filled, remaining: r.remaining, done: false })
        if (r.filled === 0 || r.remaining === 0) break
      }
    } catch {
      /* finalize below */
    } finally {
      await router.invalidate()
      setSt((s) => ({ ...s, running: false, done: true }))
    }
  }

  const label = st.running
    ? `Elevation… ${st.filled}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
    : st.done
      ? st.remaining
        ? `Filled ${st.filled} · ${st.remaining} left`
        : `Filled ${st.filled}`
      : 'Fill elevation'

  return (
    <button
      type="button"
      onClick={resolve}
      disabled={st.running}
      title="Look up ground elevation for GPS points the Fleet API didn’t include (Open-Meteo)"
      style={{
        flex: 'none',
        cursor: st.running ? 'default' : 'pointer',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: st.running ? TD : ELEV,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
        border: `1px solid ${st.running ? 'var(--border,rgba(0,0,0,0.08))' : ELEV}`,
        borderRadius: 30,
        padding: '7px 14px',
        whiteSpace: 'nowrap',
        opacity: st.running ? 0.8 : 1,
      }}
    >
      {label}
    </button>
  )
}

/**
 * Reverse-geocode backfill trigger. Loops `backfillAddresses` (throttled
 * server-side) until nothing new resolves, then invalidates the loader so the
 * freshly-named drives (and charges) re-render. Names live rows the way the
 * TeslaMate import already named historical ones.
 */
function ResolveLocationsButton({ isDark }: { isDark: boolean }) {
  const router = useRouter()
  const run = useServerFn(backfillAddresses)
  const [st, setSt] = useState<{ running: boolean; named: number; remaining: number | null; done: boolean }>({
    running: false,
    named: 0,
    remaining: null,
    done: false,
  })

  async function resolve() {
    if (st.running) return
    setSt({ running: true, named: 0, remaining: null, done: false })
    let named = 0
    try {
      for (let i = 0; i < 80; i++) {
        const r = await run()
        named += r.linked
        setSt({ running: true, named, remaining: r.remaining, done: false })
        if (r.linked === 0 || r.remaining === 0) break
      }
    } catch {
      /* finalize below */
    } finally {
      await router.invalidate()
      setSt((s) => ({ ...s, running: false, done: true }))
    }
  }

  const label = st.running
    ? `Resolving… ${st.named}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
    : st.done
      ? st.remaining
        ? `Named ${st.named} · ${st.remaining} left`
        : `Named ${st.named}`
      : 'Resolve place names'

  return (
    <button
      type="button"
      onClick={resolve}
      disabled={st.running}
      title="Look up street names for drives/charges that only show a time"
      style={{
        flex: 'none',
        cursor: st.running ? 'default' : 'pointer',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: st.running ? TD : COLOR,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
        border: `1px solid ${st.running ? 'var(--border,rgba(0,0,0,0.08))' : COLOR}`,
        borderRadius: 30,
        padding: '7px 14px',
        whiteSpace: 'nowrap',
        opacity: st.running ? 0.8 : 1,
      }}
    >
      {label}
    </button>
  )
}

/**
 * Road-match backfill trigger for the route map. Loops `backfillRouteMatch`
 * (throttled server-side, a few drives per call) until every drive has been
 * attempted, then `onDone()` re-fetches the route map so freshly road-matched
 * drives redraw on roads. When the server reports Mapbox isn't configured the
 * label nudges to set MAPBOX_TOKEN.
 */
function SnapToRoadsButton({ isDark, onDone }: { isDark: boolean; onDone: () => void }) {
  const run = useServerFn(backfillRouteMatch)
  const [st, setSt] = useState<{ running: boolean; matched: number; remaining: number | null; done: boolean; configured: boolean }>({
    running: false,
    matched: 0,
    remaining: null,
    done: false,
    configured: true,
  })

  async function snap() {
    if (st.running) return
    setSt({ running: true, matched: 0, remaining: null, done: false, configured: true })
    let matched = 0
    let configured = true
    let stalls = 0
    try {
      for (let i = 0; i < 500; i++) {
        const r = await run()
        if (!r.configured) {
          configured = false
          break
        }
        matched += r.matched
        setSt({ running: true, matched, remaining: r.remaining, done: false, configured: true })
        if (r.remaining === 0) break
        if (r.matched + r.failed > 0) {
          stalls = 0
          await sleep(400) // pace well under Mapbox's 300 req/min
        } else {
          // No progress — rate-limited/paused. Back off and retry a few times before giving up.
          if (++stalls >= 6) break
          await sleep(8000)
        }
      }
    } catch {
      /* finalize below */
    } finally {
      onDone()
      setSt((s) => ({ ...s, running: false, done: true, configured }))
    }
  }

  const label = !st.configured
    ? 'Set MAPBOX_TOKEN to snap'
    : st.running
      ? `Snapping… ${st.matched}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
      : st.done
        ? st.remaining
          ? `Snapped ${st.matched} · ${st.remaining} left`
          : `Snapped ${st.matched}`
        : 'Snap to roads'

  return (
    <button
      type="button"
      onClick={snap}
      disabled={st.running}
      title="Road-match each drive's GPS to the street network via Mapbox (cached; needs MAPBOX_TOKEN)"
      style={{
        flex: 'none',
        cursor: st.running ? 'default' : 'pointer',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: st.running ? TD : COLOR,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
        border: `1px solid ${st.running ? 'var(--border,rgba(0,0,0,0.08))' : COLOR}`,
        borderRadius: 30,
        padding: '7px 14px',
        whiteSpace: 'nowrap',
        opacity: st.running ? 0.8 : 1,
      }}
    >
      {label}
    </button>
  )
}
