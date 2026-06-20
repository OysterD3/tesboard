import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDashboardData } from '../../lib/queries'
import { Card, EmptyCard, Icon, SectionLabel, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, SECTION } from '../../components/dashboard/theme'
import { buildDriveInsights } from '../../lib/dashboard-vm'
import { lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { money } from '../../lib/format'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives_/insights')({
  component: DrivesInsightsPage,
})

const COLOR = SECTION.drives

/**
 * Drives → Insights. Streaks & milestones over a user-selected date window
 * (default last 7 days). Filters the loader's drives client-side; phantom drain
 * lives on the Idles section.
 */
function DrivesInsightsPage() {
  const { drives, charging, now } = useDashboardData()
  const { units: u, accent, theme, range, setRange } = useDash()
  const isDark = theme === 'dark'

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const vm = buildDriveInsights(drives.drives, charging.sessions, resolveRange(range, nowMs, lastChargeMs))

  const milestones = vm.hasDrives
    ? [
        { label: 'Days driven', val: vm.daysDriven != null ? String(vm.daysDriven) : '—', icon: ICON.calendar, color: '#3b82f6', tint: 'rgba(59,130,246,0.13)' },
        { label: 'Longest drive', val: vm.longestKm != null ? `${fmtDist(u, vm.longestKm)} ${distUnit(u)}` : '—', icon: ICON.road, color: '#6366f1', tint: 'rgba(99,102,241,0.13)' },
        { label: 'Most efficient drive', val: vm.mostEffWhKm != null ? `${effFromWhKm(u, vm.mostEffWhKm)} ${effSuffix(u)}` : '—', icon: ICON.leaf, color: '#14b8a6', tint: 'rgba(20,184,166,0.13)' },
      ]
    : []

  return (
    <div className="evd-view flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2.5 flex-wrap">
        <ViewTitle>Drives</ViewTitle>
        <SectionTabs section="drives" value="insights" accent={COLOR} isDark={isDark} />
      </div>

      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />

      {vm.hasDrives ? (
        <Card radius={22} className="px-5 pt-1.5 pb-[18px]">
          <div className="pt-4 pb-1.5">
            <SectionLabel>Streaks &amp; milestones</SectionLabel>
          </div>
          {milestones.map((m) => (
            <div key={m.label} className="flex items-center justify-between py-[13px] border-b border-border">
              <div className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-[9px] flex items-center justify-center flex-none" style={{ background: m.tint }}>
                  <Icon d={m.icon} size={16} color={m.color} />
                </span>
                <span className="text-sm font-medium text-foreground">{m.label}</span>
              </div>
              <span className="text-[15px] font-bold tracking-[-0.01em] text-foreground">{m.val}</span>
            </div>
          ))}
          {vm.distKm != null && vm.spend != null && (
            <div className="mt-4 px-4 py-3.5 rounded-[14px]" style={{ background: hexToRgba(accent, 0.09) }}>
              <span className="text-[13px] font-semibold text-foreground leading-normal">
                You’ve driven {fmtDist(u, vm.distKm).toLocaleString('en-US')} {distUnit(u)} on {money(vm.spend, vm.currency, 0)} of energy.
              </span>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No drives in this range" body="Try a wider date range, or check back once more drives are recorded." />
      )}
    </div>
  )
}
