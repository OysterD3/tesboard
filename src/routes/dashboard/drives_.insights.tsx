import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, SECTION } from '../../components/dashboard/theme'
import { buildDriveInsights } from '../../lib/dashboard-vm'
import { lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives_/insights')({
  component: DrivesInsightsPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives

function money(amount: number | null, currency: string, digits = 0): string {
  if (amount == null) return '—'
  const v = amount.toFixed(digits)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

/**
 * Drives → Insights. Streaks & milestones over a user-selected date window
 * (default last 7 days). Filters the loader's drives client-side; phantom drain
 * lives on the Idles section.
 */
function DrivesInsightsPage() {
  const { drives, charging, now } = dashApi.useLoaderData()
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
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Drives</ViewTitle>
        <SectionTabs section="drives" value="insights" accent={COLOR} isDark={isDark} />
      </div>

      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />

      {vm.hasDrives ? (
        <Card radius={22} style={{ padding: '6px 20px 18px' }}>
          <div style={{ padding: '16px 0 6px' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Streaks &amp; milestones</span>
          </div>
          {milestones.map((m) => (
            <div key={m.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 0', borderBottom: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 32, height: 32, borderRadius: 9, background: m.tint, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                  <Icon d={m.icon} size={16} color={m.color} />
                </span>
                <span style={{ fontSize: 14, fontWeight: 500, color: TX }}>{m.label}</span>
              </div>
              <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{m.val}</span>
            </div>
          ))}
          {vm.distKm != null && vm.spend != null && (
            <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 14, background: hexToRgba(accent, 0.09) }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: TX, lineHeight: 1.5 }}>
                You’ve driven {fmtDist(u, vm.distKm).toLocaleString('en-US')} {distUnit(u)} on {money(vm.spend, vm.currency)} of energy.
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
