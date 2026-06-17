import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
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
import { getDriveRoute, getVisitedMap } from '../../functions/drives.functions'
import { exportDriveGpx } from '../../functions/export.functions'
import { backfillAddresses } from '../../functions/geocode.functions'
import { downloadString } from '../../lib/download'
import { distUnit, effFromWhKm, effSuffix, fmtDist, fmtSpeed, speedUnit } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives

type Fetched = { id: string; points: [number, number][]; sampled: boolean }

function DrivesPage() {
  const { drives, activeVin } = dashApi.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const all = buildDrives(drives, useDisplayTz())
  const months = monthOptions(all)
  const [month, setMonth] = useState('all')
  const visible = month === 'all' ? all : all.filter((d) => d.monthKey === month)
  const rows = groupByMonth(visible, (d) => d.id)
  const [selId, setSelId] = useState(all[0]?.id)
  const sel = visible.find((d) => d.id === selId) ?? visible[0]

  const fetchRoute = useServerFn(getDriveRoute)
  const [fetched, setFetched] = useState<Fetched | null>(null)

  // Map mode: a single drive's breadcrumb, or the lifetime "visited" scatter.
  const [mapView, setMapView] = useState<'drive' | 'lifetime'>('drive')
  const fetchVisited = useServerFn(getVisitedMap)
  const [visited, setVisited] = useState<{ points: [number, number][]; scanned: number } | null>(null)
  const [visitedLoading, setVisitedLoading] = useState(false)

  const fetchGpx = useServerFn(exportDriveGpx)
  const [gpxBusy, setGpxBusy] = useState(false)
  async function downloadGpx() {
    if (!sel || gpxBusy) return
    setGpxBusy(true)
    try {
      const f = await fetchGpx({ data: { driveId: sel.driveId } })
      if (f.body) downloadString(f.filename, f.mime, f.body)
    } finally {
      setGpxBusy(false)
    }
  }

  useEffect(() => {
    if (!sel) return
    let cancelled = false
    fetchRoute({ data: { driveId: sel.driveId } })
      .then((r) => {
        if (!cancelled) setFetched({ id: sel.id, points: r.points, sampled: r.sampled })
      })
      .catch(() => {
        if (!cancelled) setFetched({ id: sel.id, points: sel.endpoints, sampled: false })
      })
    return () => {
      cancelled = true
    }
  }, [sel?.id, sel?.driveId, fetchRoute])

  // Lazy-load the lifetime map the first time it's shown (refetch if the car changes).
  useEffect(() => {
    if (mapView !== 'lifetime' || visited) return
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
  }, [mapView, visited, fetchVisited, activeVin])

  // A car switch invalidates a cached lifetime map.
  useEffect(() => {
    setVisited(null)
  }, [activeVin])

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

  const points: [number, number][] = sel ? (fetched?.id === sel.id ? fetched.points : sel.endpoints) : []
  const sampled = fetched?.id === sel?.id ? fetched.sampled : false

  let caption: string | null = null
  if (sel) {
    if (points.length >= 2 && sampled) caption = `Sampled GPS · ${points.length} points`
    else if (points.length >= 1) caption = 'Approximate (start/end only — no breadcrumb yet)'
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <ViewTitle>Drives</ViewTitle>
        <ResolveLocationsButton isDark={isDark} />
      </div>

      <MapToggle value={mapView} onChange={setMapView} isDark={isDark} />

      {mapView === 'lifetime' ? (
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
      ) : (
        sel && (
          <Card radius={22} style={{ padding: 14 }}>
            <div style={{ position: 'relative' }}>
              {points.length >= 1 ? (
                <LeafletMap points={points} color={COLOR} isDark={isDark} />
              ) : (
                <div style={{ height: 206, borderRadius: 16, border: '1px solid var(--border,rgba(0,0,0,0.07))', background: 'var(--track,#f0f0f3)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 20 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>No GPS recorded for this drive.</span>
                </div>
              )}
              <div style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 500, pointerEvents: 'none', fontSize: 11, fontWeight: 600, color: TX, background: 'var(--card,#fff)', padding: '6px 11px', borderRadius: 20, border: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
                {sel.title}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
              {caption ? <span style={{ fontSize: 10, fontWeight: 500, color: TD, paddingLeft: 2 }}>{caption}</span> : <span />}
              {points.length >= 1 && (
                <button
                  type="button"
                  onClick={downloadGpx}
                  disabled={gpxBusy}
                  title="Download this drive as a GPX track"
                  style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: COLOR, background: 'none', border: `1px solid ${COLOR}`, borderRadius: 30, padding: '5px 12px', cursor: gpxBusy ? 'default' : 'pointer', opacity: gpxBusy ? 0.6 : 1, whiteSpace: 'nowrap' }}
                >
                  {gpxBusy ? 'Exporting…' : 'Export GPX'}
                </button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginTop: 16 }}>
              <StatCell value={`${fmtDist(u, sel.distKm, 1)} ${distUnit(u)}`} label="Distance" />
              <StatCell value={`${sel.durMin}m`} label="Duration" />
              <StatCell value={`${fmtSpeed(u, sel.avgKph)} ${speedUnit(u)}`} label="Avg speed" />
              <StatCell value={sel.kwh != null ? `${sel.kwh} kWh` : '—'} label="Energy" />
              <StatCell value={sel.effWhKm != null ? String(effFromWhKm(u, sel.effWhKm)) : '—'} label={effSuffix(u)} />
            </div>
          </Card>
        )
      )}

      <MonthFilter months={months} value={month} onChange={setMonth} color={COLOR} isDark={isDark} />

      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        renderRow={(r) => {
          if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
          const d = r.item
          const active = d.id === sel?.id
          return (
            <ListRow
              active={active}
              color={COLOR}
              isDark={isDark}
              onClick={() => setSelId(d.id)}
              left={
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
                  <RowDot active={active} color={COLOR} isDark={isDark}>
                    <Icon d={ICON.arrow} size={18} color={active ? COLOR : TD} />
                  </RowDot>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.when}</span>
                  </div>
                </div>
              }
              right={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: 'none', paddingLeft: 12 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{fmtDist(u, d.distKm, 1)} {distUnit(u)}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
                    {d.effWhKm != null ? `${effFromWhKm(u, d.effWhKm)} ${effSuffix(u)} · ` : ''}{d.durMin} min
                  </span>
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

function MapToggle({
  value,
  onChange,
  isDark,
}: {
  value: 'drive' | 'lifetime'
  onChange: (v: 'drive' | 'lifetime') => void
  isDark: boolean
}) {
  const opts: { key: 'drive' | 'lifetime'; label: string }[] = [
    { key: 'drive', label: 'This drive' },
    { key: 'lifetime', label: 'Lifetime' },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--track,#f0f0f3)', borderRadius: 30, padding: 4, alignSelf: 'flex-start' }}>
      {opts.map((o) => {
        const active = o.key === value
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              color: active ? '#fff' : TD,
              background: active ? COLOR : 'transparent',
              border: 'none',
              borderRadius: 30,
              padding: '6px 14px',
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{value}</span>
      <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>{label}</span>
    </div>
  )
}
