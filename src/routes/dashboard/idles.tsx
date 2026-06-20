import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { BatteryGlyph, EmptyCard, Icon, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import type { IdleVM } from '../../lib/idles-vm'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { buildIdles, fmtIdleDuration } from '../../lib/idles-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthFilter, MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth, monthOptions } from '../../lib/month-group'

export const Route = createFileRoute('/dashboard/idles')({
  component: IdlesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.idles

const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
]

function IdlesPage() {
  const { drives, overview, activeVin } = dashApi.useLoaderData()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const vw = overview.vehicles.find((v) => v.vehicle.vin === activeVin) ?? overview.vehicles[0]
  const all = buildIdles(drives.drives, {
    tz: useDisplayTz(),
    effWhPerMi: vw?.vehicle.efficiency_wh_per_mi ?? null,
    packKwh: vw?.vehicle.pack_kwh ?? null,
  })
  const months = monthOptions(all)
  const [month, setMonth] = useState('all')
  const visible = month === 'all' ? all : all.filter((d) => d.monthKey === month)
  const rows = groupByMonth(visible, (d) => d.id)

  function open(id: string) {
    navigate({ to: '/dashboard/idles/$idleId', params: { idleId: id }, search: (prev) => prev })
  }

  if (all.length === 0) {
    return (
      <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ViewTitle>Idles</ViewTitle>
        <EmptyCard
          title="No idle periods yet"
          body="Idles are the parked gaps between two drives. They appear once the poller has recorded at least two drives for this car."
        />
      </div>
    )
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Idles</ViewTitle>
        <Segmented
          options={VIEW_OPTIONS}
          value="history"
          onChange={(v) => {
            if (v === 'map') navigate({ to: '/dashboard/idles/map', search: (prev) => prev })
          }}
          accent={COLOR}
          isDark={isDark}
        />
      </div>

      <MonthFilter months={months} value={month} onChange={setMonth} color={COLOR} isDark={isDark} />

      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        estimateRowHeight={172}
        renderRow={(r) => {
          if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
          return <IdleCard d={r.item} isDark={isDark} onClick={() => open(r.item.id)} />
        }}
      />
    </div>
  )
}

/** "0.12 kWh" / "1.4 kWh" — battery drain label for the card footer. */
function fmtKwh(kwh: number): string {
  return kwh < 1 ? kwh.toFixed(2) : kwh.toFixed(1)
}

/**
 * An idle history card: a parking badge + place header, the two SOC endpoints
 * (parked at → drove off) joined by a dotted rail, then a divider and a duration /
 * energy footer. The whole card navigates to the idle detail page.
 */
function IdleCard({ d, isDark, onClick }: { d: IdleVM; isDark: boolean; onClick: () => void }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, marginBottom: 13 }}>
        <span
          style={{
            width: 32,
            height: 32,
            flex: 'none',
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba(COLOR, isDark ? 0.24 : 0.13),
          }}
        >
          <Icon d={ICON.parking} size={17} color={COLOR} width={1.8} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.title}
        </span>
      </div>

      <BatteryRow battery={d.startBattery} stamp={d.startStamp} connector />
      <BatteryRow battery={d.endBattery} stamp={d.endStamp} />

      <div style={{ borderTop: '1px solid var(--border,rgba(0,0,0,0.07))', margin: '13px 0 0', paddingTop: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>
          <Icon d={ICON.clock} size={15} color={TD} />
          {fmtIdleDuration(d.durMin)}
        </span>
        {d.batteryKwh != null && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: TD }}>
            <Icon d={ICON.battery} size={15} color={TD} />
            {fmtKwh(d.batteryKwh)} kWh
          </span>
        )}
      </div>
    </button>
  )
}

/** One SOC endpoint line of an IdleCard (battery glyph + percent + timestamp),
 *  optionally trailing a dotted rail down to the next endpoint. */
function BatteryRow({
  battery,
  stamp,
  connector = false,
}: {
  battery: number | null
  stamp: string | null
  connector?: boolean
}) {
  const meta = [battery != null ? `${battery}%` : null, stamp].filter(Boolean) as string[]
  return (
    <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
      <div style={{ width: 22, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {battery != null ? <BatteryGlyph pct={battery} color={TD} size={20} /> : <Icon d={ICON.battery} size={16} color={TD} />}
        {connector && (
          <span style={{ flex: 1, marginTop: 4, marginBottom: -2, minHeight: 14, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, paddingBottom: connector ? 14 : 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: TD, minWidth: 0, whiteSpace: 'nowrap' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.join(' · ') || '—'}</span>
        </span>
      </div>
    </div>
  )
}
