import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card, EmptyCard, Icon, ListRow, RowDot, ViewTitle } from '../../components/dashboard/primitives'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { buildDrives } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthFilter, MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth, monthOptions } from '../../lib/month-group'
import { getVisitedMap } from '../../functions/drives.functions'
import { backfillAddresses } from '../../functions/geocode.functions'
import { backfillElevation } from '../../functions/elevation.functions'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives

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

  // Lifetime "visited" map — everywhere the car has been. Lazy-loaded the first
  // time it's expanded (and re-fetched if the active car changes).
  const [showMap, setShowMap] = useState(false)
  const fetchVisited = useServerFn(getVisitedMap)
  const [visited, setVisited] = useState<{ points: [number, number][]; scanned: number } | null>(null)
  const [visitedLoading, setVisitedLoading] = useState(false)

  useEffect(() => {
    if (!showMap || visited) return
    let cancelled = false
    setVisitedLoading(true)
    fetchVisited({ data: { vin: activeVin ?? undefined } })
      .then((r) => {
        if (!cancelled) setVisited(r)
      })
      .catch(() => {
        if (!cancelled) setVisited({ points: [], scanned: 0 })
      })
      .finally(() => {
        if (!cancelled) setVisitedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showMap, visited, fetchVisited, activeVin])

  // A car switch invalidates a cached lifetime map.
  useEffect(() => {
    setVisited(null)
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

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Drives</ViewTitle>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FillElevationButton isDark={isDark} />
          <ResolveLocationsButton isDark={isDark} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowMap((s) => !s)}
        style={{
          alignSelf: 'flex-start',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: showMap ? COLOR : TD,
          background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--track,#f0f0f3)',
          border: 'none',
          borderRadius: 30,
          padding: '7px 14px',
          cursor: 'pointer',
        }}
      >
        <Icon d={ICON.pin} size={15} color={showMap ? COLOR : TD} />
        {showMap ? 'Hide lifetime map' : 'Lifetime map'}
      </button>

      {showMap && (
        <Card radius={22} style={{ padding: 14 }}>
          <div style={{ position: 'relative' }}>
            {visited && visited.points.length > 0 ? (
              <LeafletMap points={visited.points} color={COLOR} isDark={isDark} mode="scatter" height={260} />
            ) : (
              <div style={{ height: 260, borderRadius: 16, border: '1px solid var(--border,rgba(0,0,0,0.07))', background: 'var(--track,#f0f0f3)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 20 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
                  {visitedLoading ? 'Building lifetime map…' : 'No GPS points recorded yet.'}
                </span>
              </div>
            )}
            <div style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 500, pointerEvents: 'none', fontSize: 11, fontWeight: 600, color: TX, background: 'var(--card,#fff)', padding: '6px 11px', borderRadius: 20, border: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
              Everywhere you’ve been
            </div>
          </div>
          {visited && visited.points.length > 0 && (
            <div style={{ fontSize: 10, fontWeight: 500, color: TD, marginTop: 8, paddingLeft: 2 }}>
              {visited.points.length.toLocaleString()} places · sampled at the poll cadence (not road-matched)
            </div>
          )}
        </Card>
      )}

      <MonthFilter months={months} value={month} onChange={setMonth} color={COLOR} isDark={isDark} />

      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        renderRow={(r) => {
          if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
          const d = r.item
          return (
            <ListRow
              active={false}
              color={COLOR}
              isDark={isDark}
              onClick={() => open(d.id)}
              left={
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
                  <RowDot active={false} color={COLOR} isDark={isDark}>
                    <Icon d={ICON.arrow} size={18} color={TD} />
                  </RowDot>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.when}</span>
                  </div>
                </div>
              }
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', paddingLeft: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{fmtDist(u, d.distKm, 1)} {distUnit(u)}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
                      {d.effWhKm != null ? `${effFromWhKm(u, d.effWhKm)} ${effSuffix(u)} · ` : ''}{d.durMin} min
                    </span>
                  </div>
                  <Icon d={ICON.chevron} size={18} color={TD} />
                </div>
              }
            />
          )
        }}
      />
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
