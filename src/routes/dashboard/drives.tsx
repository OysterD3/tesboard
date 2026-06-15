import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card, EmptyCard, Icon, ListRow, RowDot, ViewTitle } from '../../components/dashboard/primitives'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { buildDrives } from '../../lib/dashboard-vm'
import { getDriveRoute } from '../../functions/drives.functions'
import { distUnit, fmtDist, fmtSpeed, speedUnit } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives

type Fetched = { id: string; points: [number, number][]; sampled: boolean }

function DrivesPage() {
  const { drives } = dashApi.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const list = buildDrives(drives)
  const [selId, setSelId] = useState(list[0]?.id)
  const sel = list.find((d) => d.id === selId) ?? list[0]

  const fetchRoute = useServerFn(getDriveRoute)
  const [fetched, setFetched] = useState<Fetched | null>(null)

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

  if (list.length === 0) {
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
      <ViewTitle>Drives</ViewTitle>

      {sel && (
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
          {caption && <div style={{ fontSize: 10, fontWeight: 500, color: TD, marginTop: 8, paddingLeft: 2 }}>{caption}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginTop: 16 }}>
            <StatCell value={`${fmtDist(u, sel.distKm, 1)} ${distUnit(u)}`} label="Distance" />
            <StatCell value={`${sel.durMin}m`} label="Duration" />
            <StatCell value={`${fmtSpeed(u, sel.avgKph)} ${speedUnit(u)}`} label="Avg speed" />
            <StatCell value={sel.kwh != null ? `${sel.kwh} kWh` : '—'} label="Energy" />
          </div>
        </Card>
      )}

      <VirtualList
        items={list}
        getKey={(d) => d.id}
        renderRow={(d) => {
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
                  <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{d.durMin} min</span>
                </div>
              }
            />
          )
        }}
      />
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
