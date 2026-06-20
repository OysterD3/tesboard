import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, SECTION } from '../../components/dashboard/theme'
import { buildInsights } from '../../lib/dashboard-vm'
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
 * Drives → Insights. Streaks & milestones derived from the recorded drives (and
 * the lifetime distance-on-energy summary). Reads the shared dashboard loader;
 * phantom drain is omitted here (it lives on the Idles section).
 */
function DrivesInsightsPage() {
  const { drives, charging } = dashApi.useLoaderData()
  const { units: u, accent, theme } = useDash()
  const isDark = theme === 'dark'
  const vm = buildInsights(charging, drives)

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
          {vm.lifetimeDistKm != null && vm.lifetimeSpend != null && (
            <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 14, background: hexToRgba(accent, 0.09) }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: TX, lineHeight: 1.5 }}>
                You’ve driven {fmtDist(u, vm.lifetimeDistKm).toLocaleString('en-US')} {distUnit(u)} on {money(vm.lifetimeSpend, vm.currency)} of energy.
              </span>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No drive milestones yet" body="Streaks and milestones build up from your recorded drives." />
      )}
    </div>
  )
}
