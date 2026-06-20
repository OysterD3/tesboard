import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { BatteryGlyph, Card, EmptyCard, Icon, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, SECTION } from '../../components/dashboard/theme'
import { buildChargingReview, buildSessions, type SessionVM } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthFilter, MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth, monthOptions } from '../../lib/month-group'

// History list vs the dedicated full-screen map route. The "Map" option navigates
// to /dashboard/charging/map rather than flipping in-page state.
const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
]

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

function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

function ChargingPage() {
  const { charging } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const navigate = useNavigate()
  const all = buildSessions(charging, tz)
  const review = buildChargingReview(charging, tz)
  const months = monthOptions(all)
  const [month, setMonth] = useState('all')
  const visible = month === 'all' ? all : all.filter((s) => s.monthKey === month)
  const rows = groupByMonth(visible, (s) => s.id)

  function open(id: string) {
    navigate({ to: '/dashboard/charging/$chargeId', params: { chargeId: id }, search: (prev) => prev })
  }

  if (all.length === 0) {
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

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <ViewTitle>Charging</ViewTitle>
        <Segmented
          options={VIEW_OPTIONS}
          value="history"
          onChange={(v) => {
            if (v === 'map') navigate({ to: '/dashboard/charging/map', search: (prev) => prev })
          }}
          accent={COLOR}
          isDark={isDark}
        />
      </div>

      {review.hasData && (
        <Card radius={22} style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Year in review · {review.periodLabel}</span>
            {review.busiestMonth && (
              <span style={{ fontSize: 11, fontWeight: 600, color: COLOR, padding: '5px 11px', borderRadius: 30, background: hexToRgba(COLOR, isDark ? 0.18 : 0.1), whiteSpace: 'nowrap' }}>
                Busiest · {review.busiestMonth}
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, margin: '14px 0 4px' }}>
            <SessionStat value={String(review.sessions)} label="Sessions" color={TX} />
            <SessionStat value={`${review.energyKwh}`} label="kWh added" color={TX} />
            <SessionStat value={money(review.cost, review.currency)} label="Spent" color={TX} />
          </div>

          {review.homeEnergyPct != null && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ width: `${Math.round(review.homeEnergyPct * 100)}%`, background: '#10b981' }} />
                <div style={{ width: `${100 - Math.round(review.homeEnergyPct * 100)}%`, background: '#f59e0b' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9 }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Home {Math.round(review.homeEnergyPct * 100)}% of kWh</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Supercharge {100 - Math.round(review.homeEnergyPct * 100)}%</span>
              </div>
            </div>
          )}

          {review.topLocations.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: TD }}>Top places</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 11 }}>
                {review.topLocations.map((l, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: TD, width: 14, flex: 'none' }}>{i + 1}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: TD, flex: 'none' }}>{l.sessions}× · {l.energyKwh} kWh</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <span style={{ fontSize: 13, fontWeight: 600, color: TD, paddingLeft: 2 }}>History</span>
      <MonthFilter months={months} value={month} onChange={setMonth} color={COLOR} isDark={isDark} />
      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        estimateRowHeight={150}
        renderRow={(r) => {
          if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
          return <ChargeCard c={r.item} isDark={isDark} onClick={() => open(r.item.id)} />
        }}
      />
    </div>
  )
}

/**
 * A charge-history card in the Tessie shape: a charge icon + place, a start → end
 * battery pair joined by a dotted rail (SOC + timestamp at each end), then a
 * cost / energy / duration footer. The whole card opens the charge detail page.
 */
function ChargeCard({ c, isDark, onClick }: { c: SessionVM; isDark: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left', cursor: 'pointer', background: 'var(--card,#fff)', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 18, padding: '15px 16px', display: 'flex', flexDirection: 'column', transition: 'border-color .2s ease, background .2s ease' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, marginBottom: 12 }}>
        <span style={{ width: 30, height: 30, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexToRgba(COLOR, isDark ? 0.22 : 0.12) }}>
          <Icon d={ICON.charging} size={16} color={COLOR} fill={COLOR} stroke={false} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.loc}
        </span>
      </div>

      <ChargeEndpoint battery={c.startBattery} stamp={c.startStamp} connector />
      <ChargeEndpoint battery={c.endBattery} stamp={c.endStamp} />

      <div style={{ borderTop: '1px solid var(--border,rgba(0,0,0,0.07))', margin: '13px 0 0', paddingTop: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: COLOR }}>{money(c.cost, c.currency)}</span>
        {c.addedKwh != null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: TD }}>
            <Icon d={ICON.plug} size={15} color={TD} />
            {c.addedKwh} kWh
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: TD }}>
          <Icon d={ICON.clock} size={15} color={TD} />
          {fmtDur(c.durMin)}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: TD }}>{c.type}</span>
      </div>
    </button>
  )
}

/** One end of a charge card: battery glyph + "SOC% · timestamp", optionally
 *  trailing the dotted rail down to the next endpoint. */
function ChargeEndpoint({ battery, stamp, connector = false }: { battery: number | null; stamp: string | null; connector?: boolean }) {
  const meta = [battery != null ? `${battery}%` : null, stamp].filter(Boolean) as string[]
  return (
    <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
      <div style={{ width: 22, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {battery != null ? <BatteryGlyph pct={battery} color={TD} size={18} /> : <Icon d={ICON.battery} size={16} color={TD} />}
        {connector && (
          <span style={{ flex: 1, marginTop: 4, marginBottom: -2, minHeight: 14, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', minWidth: 0, flex: 1, paddingBottom: connector ? 14 : 0, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '18px' }}>
          {meta.length ? meta.join(' · ') : '—'}
        </span>
      </div>
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
