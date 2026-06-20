import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDashboardData } from '../../lib/queries'
import {
  AccentChip,
  BatteryGlyph,
  BigStat,
  Card,
  DashCardButton,
  EmptyCard,
  Icon,
  SectionLabel,
  ViewTitle,
} from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, SECTION, THEME } from '../../components/dashboard/theme'
import { buildChargingReview, buildSessions, type SessionVM } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth } from '../../lib/month-group'
import { filterByRange, lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { fmtDurMin, money } from '../../lib/format'

export const Route = createFileRoute('/dashboard/charging')({
  component: ChargingPage,
})

const COLOR = SECTION.charging

function ChargingPage() {
  const { charging, now } = useDashboardData()
  const { theme, range, setRange } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const navigate = useNavigate()
  const review = buildChargingReview(charging, tz)

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const resolved = useMemo(() => resolveRange(range, nowMs, lastChargeMs), [range, nowMs, lastChargeMs])
  const windowed = useMemo(
    () => buildSessions({ ...charging, sessions: filterByRange(charging.sessions, resolved) }, tz),
    [charging, resolved, tz],
  )
  const rows = groupByMonth(windowed, (s) => s.id)
  const noneAtAll = charging.sessions.length === 0

  function open(id: string) {
    navigate({ to: '/dashboard/charging/$chargeId', params: { chargeId: id }, search: (prev) => prev })
  }

  return (
    <div className="evd-view flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <ViewTitle>Charging</ViewTitle>
        <SectionTabs section="charging" value="history" accent={COLOR} isDark={isDark} />
      </div>

      {review.hasData && (
        <Card radius={22} className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">Year in review · {review.periodLabel}</span>
            {review.busiestMonth && (
              <span
                className="text-[11px] font-semibold px-[11px] py-[5px] rounded-[30px] whitespace-nowrap"
                style={{ color: COLOR, background: hexToRgba(COLOR, isDark ? 0.18 : 0.1) }}
              >
                Busiest · {review.busiestMonth}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5 mt-3.5 mb-1">
            <BigStat value={String(review.sessions)} label="Sessions" />
            <BigStat value={`${review.energyKwh}`} label="kWh added" />
            <BigStat value={money(review.cost, review.currency)} label="Spent" />
          </div>

          {review.homeEnergyPct != null && (
            <div className="mt-4">
              <div className="flex h-2.5 rounded-md overflow-hidden">
                <div style={{ width: `${Math.round(review.homeEnergyPct * 100)}%`, background: '#10b981' }} />
                <div style={{ width: `${100 - Math.round(review.homeEnergyPct * 100)}%`, background: '#f59e0b' }} />
              </div>
              <div className="flex justify-between mt-[9px]">
                <span className="text-xs font-medium text-muted-foreground">Home {Math.round(review.homeEnergyPct * 100)}% of kWh</span>
                <span className="text-xs font-medium text-muted-foreground">Supercharge {100 - Math.round(review.homeEnergyPct * 100)}%</span>
              </div>
            </div>
          )}

          {review.topLocations.length > 0 && (
            <div className="mt-4 pt-3.5 border-t border-border">
              <span className="text-xs font-semibold text-muted-foreground">Top places</span>
              <div className="flex flex-col gap-[9px] mt-[11px]">
                {review.topLocations.map((l, i) => (
                  <div key={i} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className="text-xs font-bold text-muted-foreground w-3.5 flex-none">{i + 1}</span>
                      <span className="text-sm font-semibold text-foreground overflow-hidden text-ellipsis whitespace-nowrap">{l.name}</span>
                    </span>
                    <span className="text-xs font-medium text-muted-foreground flex-none">{l.sessions}× · {l.energyKwh} kWh</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <SectionLabel className="pl-0.5 font-semibold">History</SectionLabel>
      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />
      {rows.length === 0 ? (
        <EmptyCard
          title={noneAtAll ? 'No charging sessions yet' : 'No charging in this range'}
          body={
            noneAtAll
              ? 'Home sessions appear as the poller observes charging; Supercharger history backfills from Tesla’s billing on the hourly reconcile.'
              : 'Try a wider date range to see more sessions.'
          }
        />
      ) : (
        <VirtualList
          items={rows}
          getKey={(r) => r.key}
          estimateRowHeight={150}
          renderRow={(r) => {
            if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
            return <ChargeCard c={r.item} isDark={isDark} onClick={() => open(r.item.id)} />
          }}
        />
      )}
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
    <DashCardButton onClick={onClick}>
      <div className="flex items-center gap-3 min-w-0 mb-3">
        <AccentChip size={30} color={COLOR} isDark={isDark}>
          <Icon d={ICON.charging} size={16} color={COLOR} fill={COLOR} stroke={false} />
        </AccentChip>
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
          {c.loc}
        </span>
      </div>

      <ChargeEndpoint battery={c.startBattery} stamp={c.startStamp} connector />
      <ChargeEndpoint battery={c.endBattery} stamp={c.endStamp} />

      <div className="border-t border-border mt-[13px] pt-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
        <span className="text-[13px] font-bold tracking-[-0.01em]" style={{ color: COLOR }}>{money(c.cost, c.currency)}</span>
        {c.addedKwh != null && (
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
            <Icon d={ICON.plug} size={15} color={THEME.td} />
            {c.addedKwh} kWh
          </span>
        )}
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
          <Icon d={ICON.clock} size={15} color={THEME.td} />
          {fmtDurMin(c.durMin)}
        </span>
        <span className="ml-auto text-xs font-semibold text-muted-foreground">{c.type}</span>
      </div>
    </DashCardButton>
  )
}

/** One end of a charge card: battery glyph + "SOC% · timestamp", optionally
 *  trailing the dotted rail down to the next endpoint. */
function ChargeEndpoint({ battery, stamp, connector = false }: { battery: number | null; stamp: string | null; connector?: boolean }) {
  const meta = [battery != null ? `${battery}%` : null, stamp].filter(Boolean) as string[]
  return (
    <div className="flex gap-3 min-w-0">
      <div className="w-[22px] flex-none flex flex-col items-center">
        {battery != null ? <BatteryGlyph pct={battery} color={THEME.td} size={18} /> : <Icon d={ICON.battery} size={16} color={THEME.td} />}
        {connector && (
          <span className="flex-1 mt-1 -mb-0.5 min-h-3.5 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={`flex min-w-0 flex-1 items-start${connector ? ' pb-3.5' : ''}`}>
        <span className="text-[13px] font-medium text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap leading-[18px]">
          {meta.length ? meta.join(' · ') : '—'}
        </span>
      </div>
    </div>
  )
}
