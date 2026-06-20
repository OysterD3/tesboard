import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useDashboardData } from '../../lib/queries'
import { Card, BatteryRing, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { hexToRgba, ICON, THEME } from '../../components/dashboard/theme'
import { buildOverview } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
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

function OverviewPage() {
  const { linked } = dashApi.useLoaderData()
  const { overview, readiness, drives, activeVin } = useDashboardData()
  const { units: u, accent, theme } = useDash()
  const vm = buildOverview(overview, readiness, drives, activeVin, useDisplayTz())
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
    <div className="evd-view flex flex-col gap-[14px]">
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
        <Card radius={20} className="flex flex-col gap-3 p-[14px]">
          <div className="flex items-center justify-between px-1 pt-0.5">
            <span className="inline-flex items-center gap-2">
              <span
                className="flex size-[30px] flex-none items-center justify-center rounded-[9px]"
                style={{ background: hexToRgba(accent, 0.14) }}
              >
                <Icon d="M12 21s-7-5.686-7-11a7 7 0 1 1 14 0c0 5.314-7 11-7 11z M12 10a1 1 0 1 0 0 .01" size={16} color={accent} />
              </span>
              <span className="text-sm font-semibold text-foreground">Location</span>
            </span>
            {vm.locationWhen && <span className="text-xs font-medium text-muted-foreground">{vm.locationWhen}</span>}
          </div>
          <LeafletMap points={[vm.location]} color={accent} isDark={theme === 'dark'} height={220} />
        </Card>
      )}

      {/* Departure readiness */}
      {vm.ready != null && (
        <Card radius={20} className="flex items-center gap-[14px] px-[18px] py-4">
          <div
            className="flex size-10 flex-none items-center justify-center rounded-[12px]"
            style={{ background: hexToRgba(readyColor, 0.13) }}
          >
            <Icon d={vm.ready ? ICON.check : ICON.alert} size={20} color={readyColor} />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-foreground">{vm.readyTitle}</span>
            <span className="text-xs font-medium text-muted-foreground">
              {vm.soc}%{vm.rangeKm != null ? ` · ${fmtDist(u, vm.rangeKm)} ${distUnit(u)} available` : ''}
            </span>
          </div>
        </Card>
      )}

      {/* Efficiency + Odometer */}
      <div className="grid grid-cols-2 gap-[14px]">
        <StatCard label="Efficiency" chipColor="#14b8a6" icon={ICON.leaf} value={vm.effWhKm != null ? String(effFromWhKm(u, vm.effWhKm)) : '—'} sub={effUnit(u)} />
        <StatCard label="Odometer" chipColor="#3b82f6" icon="M3 12a9 9 0 1 1 18 0 M12 12l3.5-2.5" value={vm.odoKm != null ? fmtDist(u, vm.odoKm).toLocaleString('en-US') : '—'} sub={`${distUnit(u)} total`} />
      </div>

      {/* Cabin climate */}
      {vm.insideC != null && (
        <Card radius={20} className="flex items-center justify-between px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">Cabin climate</span>
            <div className="flex items-baseline gap-1">
              <span className="text-[30px] font-bold tracking-[-0.02em] text-foreground">{fmtTemp(u, vm.insideC)}</span>
              <span className="text-[15px] font-semibold text-muted-foreground">{tempUnit(u)}</span>
            </div>
            {vm.outsideC != null && <span className="text-xs font-medium text-muted-foreground">Outside {fmtTemp(u, vm.outsideC)}{tempUnit(u)}</span>}
          </div>
          <div className="flex size-[54px] flex-none items-center justify-center rounded-full bg-[rgba(245,158,11,0.14)]">
            <Icon d="M12 9a4 4 0 0 0-4 4 4 4 0 1 0 8 0 4 4 0 0 0-4-4z M12 3v6 M12 17v4 M5 12H3 M21 12h-2" size={24} color="#f59e0b" width={1.8} />
          </div>
        </Card>
      )}

      {/* Tire pressure */}
      {vm.tiresBar && (
        <Card radius={20} className="px-5 pt-[18px] pb-5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">Tire pressure · {presUnit(u)}</span>
            <span className="flex size-[30px] flex-none items-center justify-center rounded-[9px] bg-[rgba(139,92,246,0.14)]">
              <Icon d="M12 7v5l3 2" size={16} color="#8b5cf6" />
            </span>
          </div>
          <div className="mt-[14px] grid grid-cols-2 gap-x-6 gap-y-[14px]">
            {vm.tiresBar.map((bar, i) => (
              <div key={i} className="flex items-center justify-between border-b border-border pb-3">
                <span className="text-[13px] font-medium text-muted-foreground">{tirePos[i]}</span>
                <span className="text-[18px] font-bold tracking-[-0.01em] text-foreground">{bar != null ? fmtPres(u, bar) : '—'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Last drive */}
      {vm.lastDrive && (
        <button
          onClick={() => navigate({ to: '/dashboard/drives', search: (prev) => prev })}
          className="flex w-full cursor-pointer items-center justify-between rounded-[20px] border border-border bg-card px-5 py-[18px] text-left shadow-[var(--shadow)]"
        >
          <div className="flex items-center gap-[14px]">
            <div className="flex size-[38px] flex-none items-center justify-center rounded-[11px] bg-[rgba(99,102,241,0.12)]">
              <Icon d={ICON.arrow} size={18} color="#6366f1" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-muted-foreground">Last drive</span>
              <span className="text-base font-bold tracking-[-0.01em] text-foreground">{vm.lastDrive.title}</span>
              <span className="text-xs font-medium text-muted-foreground">
                {fmtDist(u, vm.lastDrive.distKm, 1)} {distUnit(u)} · {vm.lastDrive.durMin} min
                {vm.lastDrive.effWhKm != null ? ` · ${effFromWhKm(u, vm.lastDrive.effWhKm)} ${effSuffix(u)}` : ''}
              </span>
            </div>
          </div>
          <Icon d={ICON.chevron} size={20} color={THEME.td} />
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
    <Card radius={20} className="p-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <span
          className="flex size-[30px] flex-none items-center justify-center rounded-[9px]"
          style={{ background: hexToRgba(chipColor, 0.14) }}
        >
          <Icon d={icon} size={16} color={chipColor} />
        </span>
      </div>
      <div className="mt-2.5 text-[26px] font-bold tracking-[-0.02em] text-foreground">{value}</div>
      <span className="text-xs font-medium text-muted-foreground">{sub}</span>
    </Card>
  )
}
