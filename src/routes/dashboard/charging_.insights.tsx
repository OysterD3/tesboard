import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { Card, EmptyCard, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
import { buildInsights } from '../../lib/dashboard-vm'
import { distUnit } from '../../lib/units'

export const Route = createFileRoute('/dashboard/charging_/insights')({
  component: ChargingInsightsPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.charging

function money(amount: number | null, currency: string, digits = 0): string {
  if (amount == null) return '—'
  const v = amount.toFixed(digits)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

/**
 * Charging → Insights. Cost of ownership: monthly run-rate, per-distance cost,
 * lifetime spend, and the home-vs-supercharge cost split. Derived from the
 * shared dashboard loader (no extra fetch).
 */
function ChargingInsightsPage() {
  const { drives, charging } = dashApi.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const vm = buildInsights(charging, drives)

  const homePct = vm.homePct != null ? Math.round(vm.homePct * 100) : null
  const costPerDist = vm.costPerMi != null ? (u.dist === 'mi' ? vm.costPerMi : vm.costPerMi / 1.60934) : null

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <ViewTitle>Charging</ViewTitle>
        <SectionTabs section="charging" value="insights" accent={COLOR} isDark={isDark} />
      </div>

      {vm.hasCharge ? (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Cost of ownership</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em', color: TX }}>{money(vm.costPerMonth, vm.currency)}</span>
            <span style={{ fontSize: 17, fontWeight: 600, color: TD }}>/mo</span>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
            <Mini value={money(costPerDist, vm.currency, 3)} label={`${vm.currency === 'USD' ? '$' : vm.currency} / ${distUnit(u)}`} />
            <Mini value={money(vm.lifetimeSpend, vm.currency)} label="Lifetime spend" />
          </div>
          {homePct != null && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ width: `${homePct}%`, background: '#10b981' }} />
                <div style={{ width: `${100 - homePct}%`, background: '#f59e0b' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                <Legend color="#10b981" label={`Home ${homePct}%`} />
                <Legend color="#f59e0b" label={`Supercharge ${100 - homePct}%`} />
              </div>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No cost data yet" body="Cost of ownership appears once you’ve recorded charging sessions and set an electricity rate in Settings." />
      )}
    </div>
  )
}

function Mini({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{value}</span>
      <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>{label}</span>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 500, color: TD }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      {label}
    </span>
  )
}
