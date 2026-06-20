import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useDashboardData } from '../../lib/queries'
import { AccentChip, BatteryGlyph, DashCardButton, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import type { IdleVM } from '../../lib/idles-vm'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, THEME } from '../../components/dashboard/theme'
import { buildIdles, fmtIdleDuration } from '../../lib/idles-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth } from '../../lib/month-group'
import { inRangeMs, lastChargeMsOf, resolveRange } from '../../lib/range-filter'

export const Route = createFileRoute('/dashboard/idles')({
  component: IdlesPage,
})

const COLOR = SECTION.idles

function IdlesPage() {
  const { drives, overview, activeVin, charging, now } = useDashboardData()
  const { theme, range, setRange } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()

  const vw = overview.vehicles.find((v) => v.vehicle.vin === activeVin) ?? overview.vehicles[0]
  const allIdles = buildIdles(drives.drives, {
    tz: useDisplayTz(),
    effWhPerMi: vw?.vehicle.efficiency_wh_per_mi ?? null,
    packKwh: vw?.vehicle.pack_kwh ?? null,
  })

  const nowMs = Date.parse(now)
  const lastChargeMs = lastChargeMsOf(charging.sessions)
  const resolved = resolveRange(range, nowMs, lastChargeMs)
  const windowed = allIdles.filter((d) => inRangeMs(d.startMs, resolved))
  const rows = groupByMonth(windowed, (d) => d.id)
  const noneAtAll = allIdles.length === 0

  function open(id: string) {
    navigate({ to: '/dashboard/idles/$idleId', params: { idleId: id }, search: (prev) => prev })
  }

  return (
    <div className="evd-view flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2.5 flex-wrap">
        <ViewTitle>Idles</ViewTitle>
        <SectionTabs section="idles" value="history" accent={COLOR} isDark={isDark} />
      </div>

      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />

      {rows.length === 0 ? (
        <EmptyCard
          title={noneAtAll ? 'No idle periods yet' : 'No idles in this range'}
          body={
            noneAtAll
              ? 'Idles are the parked gaps between two drives. They appear once the poller has recorded at least two drives for this car.'
              : 'Try a wider date range to see more idles.'
          }
        />
      ) : (
        <VirtualList
          items={rows}
          getKey={(r) => r.key}
          estimateRowHeight={172}
          renderRow={(r) => {
            if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
            return <IdleCard d={r.item} isDark={isDark} onClick={() => open(r.item.id)} />
          }}
        />
      )}
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
    <DashCardButton onClick={onClick}>
      <div className="flex items-center gap-2.5 min-w-0 mb-[13px]">
        <AccentChip size={32} color={COLOR} isDark={isDark} round={false} className="rounded-[9px]">
          <Icon d={ICON.parking} size={17} color={COLOR} width={1.8} />
        </AccentChip>
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
          {d.title}
        </span>
      </div>

      <BatteryRow battery={d.startBattery} stamp={d.startStamp} connector />
      <BatteryRow battery={d.endBattery} stamp={d.endStamp} />

      <div className="border-t border-border mt-[13px] pt-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[13px] font-bold tracking-[-0.01em] text-foreground">
          <Icon d={ICON.clock} size={15} color={THEME.td} />
          {fmtIdleDuration(d.durMin)}
        </span>
        {d.batteryKwh != null && (
          <span className="ml-auto flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
            <Icon d={ICON.battery} size={15} color={THEME.td} />
            {fmtKwh(d.batteryKwh)} kWh
          </span>
        )}
      </div>
    </DashCardButton>
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
    <div className="flex gap-3 min-w-0">
      <div className="w-[22px] flex-none flex flex-col items-center">
        {battery != null ? <BatteryGlyph pct={battery} color={THEME.td} size={20} /> : <Icon d={ICON.battery} size={16} color={THEME.td} />}
        {connector && (
          <span className="flex-1 mt-1 -mb-0.5 min-h-3.5 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={`flex flex-col min-w-0 flex-1${connector ? ' pb-3.5' : ''}`}>
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground min-w-0 whitespace-nowrap">
          <span className="overflow-hidden text-ellipsis">{meta.join(' · ') || '—'}</span>
        </span>
      </div>
    </div>
  )
}
