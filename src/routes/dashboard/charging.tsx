import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card, ChargeCurve, EmptyCard, ListRow, RowDot, ViewTitle } from '../../components/dashboard/primitives'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, SECTION } from '../../components/dashboard/theme'
import { buildSessions } from '../../lib/dashboard-vm'
import { getChargeDetail, type ChargeDetail } from '../../functions/charging.functions'

export const Route = createFileRoute('/dashboard/charging')({
  component: ChargingPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.charging

function money(amount: number | null, currency: string): string {
  if (amount == null) return '—'
  return currency === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

function timeline(d: ChargeDetail, durMin: number): string {
  if (d.hit80 != null && d.hit100 != null) return `80% at ${d.hit80}m · 100% at ${d.hit100}m`
  if (d.hit80 != null) return `80% at ${d.hit80}m · stopped`
  return `${durMin}m total`
}

type FetchedDetail = { id: string; detail: ChargeDetail }

function ChargingPage() {
  const { charging } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const list = buildSessions(charging)
  const [selId, setSelId] = useState(list[0]?.id)
  const sel = list.find((s) => s.id === selId) ?? list[0]

  const fetchDetail = useServerFn(getChargeDetail)
  const [fetched, setFetched] = useState<FetchedDetail | null>(null)

  useEffect(() => {
    if (!sel) return
    let cancelled = false
    fetchDetail({ data: { sessionId: sel.sessionId } })
      .then((d) => {
        if (!cancelled) setFetched({ id: sel.id, detail: d })
      })
      .catch(() => {
        if (!cancelled) setFetched(null)
      })
    return () => {
      cancelled = true
    }
  }, [sel?.id, sel?.sessionId, fetchDetail])

  if (list.length === 0) {
    return (
      <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ViewTitle>Charging</ViewTitle>
        <EmptyCard
          title="No charging sessions yet"
          body="Home sessions appear as the poller observes charging; Supercharger history backfills from Tesla’s billing on the hourly reconcile."
        />
      </div>
    )
  }

  const detail = fetched?.id === sel?.id ? fetched.detail : null
  const peak = detail?.peakKw ?? null
  const axisMax = peak != null ? (peak <= 15 ? 15 : Math.ceil(peak / 50) * 50) : null
  const minAbove80 = detail?.minAbove80 ?? 0
  const wastedColor = minAbove80 > 0 ? '#f43f5e' : TX
  const socRange =
    detail?.soc0 != null && detail.soc1 != null
      ? `${detail.soc0}% → ${detail.soc1}%`
      : sel?.addedKwh != null
        ? `+${sel.addedKwh} kWh`
        : ''

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewTitle>Charging</ViewTitle>

      {sel && (
        <Card radius={22} style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel.loc}</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{sel.when}</span>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: COLOR, padding: '7px 13px', borderRadius: 30, background: hexToRgba(COLOR, isDark ? 0.18 : 0.1), whiteSpace: 'nowrap', flex: 'none', marginLeft: 12 }}>{sel.type}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '10px 0 14px' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Peak</span>
            <span style={{ fontSize: 38, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em', color: TX }}>{peak ?? '—'}</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: TD }}>kW</span>
          </div>

          {detail && detail.curve.length >= 2 && axisMax != null ? (
            <ChargeCurve curve={detail.curve} axisMax={axisMax} color={COLOR} socRange={socRange} taperFrac={detail.taperFrac} />
          ) : (
            <div style={{ height: 128, borderRadius: 14, border: '1px solid var(--border,rgba(0,0,0,0.07))', background: 'var(--track,#f7f7f9)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>
                {detail ? 'No power readings captured for this session.' : 'Loading power curve…'}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Completion</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: TX }}>{detail ? timeline(detail, sel.durMin) : '—'}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginTop: 14 }}>
            <SessionStat value={sel.addedKwh != null ? `+${sel.addedKwh}` : '—'} label="Added" color={TX} />
            <SessionStat value={`${sel.durMin}m`} label="Minutes" color={TX} />
            <SessionStat value={money(sel.cost, sel.currency)} label="Cost" color={TX} />
            <SessionStat value={detail ? `${minAbove80}m` : '—'} label="> 80%" color={wastedColor} />
          </div>
        </Card>
      )}

      <span style={{ fontSize: 13, fontWeight: 600, color: TD, paddingLeft: 2 }}>History</span>
      <VirtualList
        items={list}
        getKey={(c) => c.id}
        renderRow={(c) => {
          const active = c.id === sel?.id
          return (
            <ListRow
              active={active}
              color={COLOR}
              isDark={isDark}
              onClick={() => setSelId(c.id)}
              left={
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
                  <RowDot active={active} color={COLOR} isDark={isDark}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill={active ? COLOR : TD} stroke="none">
                      <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" />
                    </svg>
                  </RowDot>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'left', minWidth: 0 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.loc}</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.when} · {c.type}</span>
                  </div>
                </div>
              }
              right={
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: 'none', paddingLeft: 12 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{c.addedKwh != null ? `+${c.addedKwh} kWh` : '—'}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{money(c.cost, c.currency)}</span>
                </div>
              }
            />
          )
        }}
      />
    </div>
  )
}

function SessionStat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
      <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color }}>{value}</span>
      <span style={{ fontSize: 10, fontWeight: 500, color: TD }}>{label}</span>
    </div>
  )
}
