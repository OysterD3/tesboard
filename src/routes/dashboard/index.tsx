import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { Card, BatteryRing, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON } from '../../components/dashboard/theme'
import { buildOverview } from '../../lib/dashboard-vm'
import { cn } from '../../lib/utils'
import {
  distUnit,
  effFromWhKm,
  effSuffix,
  effUnit,
  fmtDist,
  fmtPres,
  fmtTemp,
  presUnit,
  tempUnit,
} from '../../lib/units'

export const Route = createFileRoute('/dashboard/')({
  component: OverviewPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

function OverviewPage() {
  const { overview, readiness, drives, linked, activeVin } = dashApi.useLoaderData()
  const { units: u, accent, theme } = useDash()
  const vm = buildOverview(overview, readiness, drives, activeVin)
  const navigate = useNavigate()

  if (!vm.hasSnapshot) {
    return (
      <div className="evd-view">
        <EmptyCard
          title="No vehicle data yet"
          body={
            linked
              ? 'Your Tesla is linked. Readings appear here after the next poll cycle (the car must be online for the poller to capture a snapshot).'
              : 'Link your Tesla account to start collecting data.'
          }
        />
      </div>
    )
  }

  const readyColor = vm.ready ? '#34c759' : '#f59e0b'
  const tirePos = ['Front left', 'Front right', 'Rear left', 'Rear right']

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Battery */}
      <Card radius={24} className="px-[22px] pt-[22px] pb-[26px]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Battery</span>
          <span className="inline-flex items-center gap-[7px] rounded-full bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            <span
              className={cn(
                'size-[7px] rounded-full',
                vm.statusLabel === 'Charging'
                  ? 'bg-[#34c759]'
                  : vm.statusLabel === 'Driving'
                    ? 'bg-[#0a84ff]'
                    : 'bg-muted-foreground',
              )}
            />
            {vm.statusLabel}
          </span>
        </div>
        <BatteryRing soc={vm.soc} accent={accent} />
        <div className="mt-2.5 flex items-baseline justify-center gap-[7px] border-t border-border pt-[18px]">
          <span className="text-[15px] font-medium text-muted-foreground">Estimated range</span>
          <span className="text-[22px] font-bold tracking-[-0.02em] text-foreground">{vm.rangeKm != null ? fmtDist(u, vm.rangeKm) : '—'}</span>
          <span className="text-sm font-semibold text-muted-foreground">{distUnit(u)}</span>
        </div>
      </Card>

      {/* Location */}
      {vm.location && (
        <Card radius={20} style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 0' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, background: hexToRgba(accent, 0.14), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Icon d="M12 21s-7-5.686-7-11a7 7 0 1 1 14 0c0 5.314-7 11-7 11z M12 10a1 1 0 1 0 0 .01" size={16} color={accent} />
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: TX }}>Location</span>
            </span>
            {vm.locationWhen && <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{vm.locationWhen}</span>}
          </div>
          <LeafletMap points={[vm.location]} color={accent} isDark={theme === 'dark'} height={220} />
        </Card>
      )}

      {/* Departure readiness */}
      {vm.ready != null && (
        <Card radius={20} style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: hexToRgba(readyColor, 0.13), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <Icon d={vm.ready ? ICON.check : ICON.alert} size={20} color={readyColor} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: TX }}>{vm.readyTitle}</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
              {vm.soc}%{vm.rangeKm != null ? ` · ${fmtDist(u, vm.rangeKm)} ${distUnit(u)} available` : ''}
            </span>
          </div>
        </Card>
      )}

      {/* Efficiency + Odometer */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <StatCard label="Efficiency" chipColor="#14b8a6" icon={ICON.leaf} value={vm.effWhKm != null ? String(effFromWhKm(u, vm.effWhKm)) : '—'} sub={effUnit(u)} />
        <StatCard label="Odometer" chipColor="#3b82f6" icon="M3 12a9 9 0 1 1 18 0 M12 12l3.5-2.5" value={vm.odoKm != null ? fmtDist(u, vm.odoKm).toLocaleString('en-US') : '—'} sub={`${distUnit(u)} total`} />
      </div>

      {/* Cabin climate */}
      {vm.insideC != null && (
        <Card radius={20} style={{ padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Cabin climate</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>{fmtTemp(u, vm.insideC)}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: TD }}>{tempUnit(u)}</span>
            </div>
            {vm.outsideC != null && <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Outside {fmtTemp(u, vm.outsideC)}{tempUnit(u)}</span>}
          </div>
          <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'rgba(245,158,11,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
            <Icon d="M12 9a4 4 0 0 0-4 4 4 4 0 1 0 8 0 4 4 0 0 0-4-4z M12 3v6 M12 17v4 M5 12H3 M21 12h-2" size={24} color="#f59e0b" width={1.8} />
          </div>
        </Card>
      )}

      {/* Tire pressure */}
      {vm.tiresBar && (
        <Card radius={20} style={{ padding: '18px 20px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Tire pressure · {presUnit(u)}</span>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(139,92,246,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Icon d="M12 7v5l3 2" size={16} color="#8b5cf6" />
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 24px', marginTop: 14 }}>
            {vm.tiresBar.map((bar, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottom: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{tirePos[i]}</span>
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{bar != null ? fmtPres(u, bar) : '—'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Last drive */}
      {vm.lastDrive && (
        <button
          onClick={() => navigate({ to: '/dashboard/drives', search: (prev) => prev })}
          style={{ textAlign: 'left', border: '1px solid var(--border,rgba(0,0,0,0.07))', cursor: 'pointer', background: 'var(--card,#fff)', borderRadius: 20, boxShadow: 'var(--shadow)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(99,102,241,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Icon d={ICON.arrow} size={18} color="#6366f1" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Last drive</span>
              <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{vm.lastDrive.title}</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
                {fmtDist(u, vm.lastDrive.distKm, 1)} {distUnit(u)} · {vm.lastDrive.durMin} min
                {vm.lastDrive.effWhKm != null ? ` · ${effFromWhKm(u, vm.lastDrive.effWhKm)} ${effSuffix(u)}` : ''}
              </span>
            </div>
          </div>
          <Icon d={ICON.chevron} size={20} color={TD} />
        </button>
      )}
    </div>
  )
}

function StatCard({
  label,
  chipColor,
  icon,
  value,
  sub,
}: {
  label: string
  chipColor: string
  icon: string
  value: string
  sub: string
}) {
  return (
    <Card radius={20} style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{label}</span>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: hexToRgba(chipColor, 0.14), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <Icon d={icon} size={16} color={chipColor} />
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', color: TX, marginTop: 10 }}>{value}</div>
      <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{sub}</span>
    </Card>
  )
}
