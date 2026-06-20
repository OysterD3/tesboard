import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDashboardData } from '../../lib/queries'
import { Card, EmptyCard, SectionLabel, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { buildChargeInsights } from '../../lib/dashboard-vm'
import { lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { money } from '../../lib/format'
import { distUnit } from '../../lib/units'

export const Route = createFileRoute('/dashboard/charging_/insights')({
  component: ChargingInsightsPage,
})

const COLOR = SECTION.charging

/**
 * Charging → Insights. Cost of ownership over a user-selected date window
 * (default last 7 days): monthly run-rate, per-distance cost, spend, and the
 * home-vs-supercharge split. Filters the loader's sessions client-side.
 */
function ChargingInsightsPage() {
  const { charging, now } = useDashboardData()
  const { units: u, theme, range, setRange } = useDash()
  const isDark = theme === 'dark'

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const vm = buildChargeInsights(charging.sessions, resolveRange(range, nowMs, lastChargeMs))

  const homePct = vm.homePct != null ? Math.round(vm.homePct * 100) : null
  const costPerDist = vm.costPerMi != null ? (u.dist === 'mi' ? vm.costPerMi : vm.costPerMi / 1.60934) : null

  return (
    <div className="evd-view flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <ViewTitle>Charging</ViewTitle>
        <SectionTabs section="charging" value="insights" accent={COLOR} isDark={isDark} />
      </div>

      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />

      {vm.hasCharge ? (
        <Card radius={22} className="p-5">
          <SectionLabel>Cost of ownership</SectionLabel>
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="text-[46px] font-bold leading-none tracking-[-0.04em] text-foreground">{money(vm.costPerMonth, vm.currency, 0)}</span>
            <span className="text-[17px] font-semibold text-muted-foreground">/mo</span>
          </div>
          <div className="flex gap-6 mt-4">
            <Mini value={money(costPerDist, vm.currency, 3)} label={`${vm.currency === 'USD' ? '$' : vm.currency} / ${distUnit(u)}`} />
            <Mini value={money(vm.spend, vm.currency, 0)} label="Spent" />
          </div>
          {homePct != null && (
            <div className="mt-[18px]">
              <div className="flex h-2.5 rounded-md overflow-hidden">
                <div className="bg-emerald-500" style={{ width: `${homePct}%` }} />
                <div className="bg-amber-500" style={{ width: `${100 - homePct}%` }} />
              </div>
              <div className="flex justify-between mt-2.5">
                <Legend color="#10b981" label={`Home ${homePct}%`} />
                <Legend color="#f59e0b" label={`Supercharge ${100 - homePct}%`} />
              </div>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No charging in this range" body="Try a wider date range, or set an electricity rate in Settings once sessions are recorded." />
      )}
    </div>
  )
}

function Mini({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <span className="text-[18px] font-bold tracking-[-0.01em] text-foreground">{value}</span>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-[7px] text-xs font-medium text-muted-foreground">
      <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )
}
