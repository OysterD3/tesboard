import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON } from '../../components/dashboard/theme'
import { buildInsights, buildOverview } from '../../lib/dashboard-vm'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/insights')({
  component: InsightsPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

function money(amount: number | null, currency: string, digits = 0): string {
  if (amount == null) return '—'
  const v = amount.toFixed(digits)
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`
}

function InsightsPage() {
  const { overview, readiness, drives, charging, phantom, activeVin } = dashApi.useLoaderData()
  const { units: u, accent } = useDash()

  const ov = buildOverview(overview, readiness, drives, activeVin)
  const vm = buildInsights(charging, drives, ov.odoKm, phantom)

  const homePct = vm.homePct != null ? Math.round(vm.homePct * 100) : null
  const costPerDist = vm.costPerMi != null ? (u.dist === 'mi' ? vm.costPerMi : vm.costPerMi / 1.60934) : null

  const milestones = vm.hasDrives
    ? [
        { label: 'Days driven', val: vm.daysDriven != null ? String(vm.daysDriven) : '—', icon: ICON.calendar, color: '#3b82f6', tint: 'rgba(59,130,246,0.13)' },
        { label: 'Longest drive', val: vm.longestKm != null ? `${fmtDist(u, vm.longestKm)} ${distUnit(u)}` : '—', icon: ICON.road, color: '#6366f1', tint: 'rgba(99,102,241,0.13)' },
        { label: 'Most efficient drive', val: vm.mostEffWhKm != null ? `${effFromWhKm(u, vm.mostEffWhKm)} ${effSuffix(u)}` : '—', icon: ICON.leaf, color: '#14b8a6', tint: 'rgba(20,184,166,0.13)' },
      ]
    : []

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ViewTitle>Insights</ViewTitle>

      {/* Cost of ownership */}
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

      {/* Streaks & milestones */}
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

      {/* Phantom miles (derived from snapshots) */}
      {vm.phantom ? (
        <Card radius={22} style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Standby loss · phantom {distUnit(u)}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>{fmtDist(u, vm.phantom.lostKm, 1)}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: TD }}>{distUnit(u)} lost</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Over {vm.phantom.days} days parked · ~{fmtDist(u, vm.phantom.perDayKm, 1)} {distUnit(u)}/day</span>
            </div>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(244,63,94,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Icon d={ICON.sparkles} size={22} color="#f43f5e" />
            </div>
          </div>
          {vm.phantom.series.length >= 2 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 40 }}>
                {(() => {
                  const series = vm.phantom.series.slice(-30)
                  const max = Math.max(...series, 0.1)
                  return series.map((v, i) => (
                    <div
                      key={i}
                      style={{ flex: 1, height: `${Math.max(6, (v / max) * 100)}%`, background: '#f43f5e', opacity: 0.55, borderRadius: 2 }}
                    />
                  ))
                })()}
              </div>
              <span style={{ fontSize: 11, fontWeight: 500, color: TD, marginTop: 7, display: 'block' }}>Daily loss · last {Math.min(30, vm.phantom.series.length)} days with drain</span>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No standby loss measured yet" body="Phantom drain is derived from snapshots taken while parked and unplugged — it appears once enough have accumulated." />
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
