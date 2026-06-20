import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BackHeader, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { BatteryScatter, type ScatterPoint } from '../../components/dashboard/BatteryScatter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, hexToRgba } from '../../components/dashboard/theme'
import { distUnit, fmtDist } from '../../lib/units'
import { round1, round2 } from '../../lib/format'
import { batteryQuery } from '../../lib/queries'

export const Route = createFileRoute('/dashboard/battery')({
  // Loaded lazily here (not in the every-route parent loader) to keep SSR CPU low.
  loaderDeps: ({ search }) => ({ vin: (search as { vin?: string }).vin }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(batteryQuery(deps.vin)),
  component: BatteryHealthPage,
})

const MI_TO_KM = 1.609344

function BatteryHealthPage() {
  const battery = useSuspenseQuery(batteryQuery(Route.useLoaderDeps().vin)).data
  const { units: u, accent, theme } = useDash()
  const isDark = theme === 'dark'

  const odoReadings = (battery.readings ?? []).filter((r) => r.odometerMi != null)
  const capPoints: ScatterPoint[] = odoReadings
    .filter((r) => r.capacityKwh != null)
    .map((r) => ({ x: r.odometerMi as number, y: r.capacityKwh as number }))
  const rangePoints: ScatterPoint[] = odoReadings
    .filter((r) => r.maxRangeMi != null)
    .map((r) => ({ x: r.odometerMi as number, y: r.maxRangeMi as number }))

  const fmtOdo = (mi: number) => `${fmtDist(u, mi * MI_TO_KM).toLocaleString('en-US')} ${distUnit(u)}`

  return (
    <div className="evd-view flex flex-col gap-[14px]">
      <BackHeader to="/dashboard/analytics" title="Battery health" />

      {capPoints.length < 2 && rangePoints.length < 2 ? (
        <EmptyCard
          title="Not enough charge readings yet"
          body="Capacity and max-range readings are collected after every charge above 5 kWh. They’ll plot here against odometer as you log a few (a TeslaMate/Tessie import backfills them)."
        />
      ) : (
        <>
          <MetricCard
            icon={ICON.battery}
            title="Capacity"
            blurb="The battery’s usable energy capacity. Readings collected after every charge above 5 kWh."
            total={battery.currentKwh != null ? round2(battery.currentKwh).toLocaleString('en-US') : '—'}
            unit="kWh"
            sub={
              battery.degradationPct != null && battery.maxKwh != null
                ? `${round1(100 - battery.degradationPct)}% of best · ${round1(battery.maxKwh)} kWh peak`
                : null
            }
            points={capPoints}
            accent={accent}
            isDark={isDark}
            formatX={fmtOdo}
            formatY={(kwh) => `${round1(kwh)}`}
            unitX={distUnit(u)}
          />

          <MetricCard
            icon={ICON.road}
            title="Max range"
            blurb="The vehicle’s estimated range at 100%. Readings collected after every charge above 5 kWh."
            total={
              battery.currentMaxRangeMi != null
                ? fmtDist(u, battery.currentMaxRangeMi * MI_TO_KM).toLocaleString('en-US')
                : '—'
            }
            unit={distUnit(u)}
            sub={
              battery.maxRangeBestMi != null
                ? `best ${fmtDist(u, battery.maxRangeBestMi * MI_TO_KM).toLocaleString('en-US')} ${distUnit(u)}`
                : null
            }
            points={rangePoints}
            accent={accent}
            isDark={isDark}
            formatX={fmtOdo}
            formatY={(mi) => `${fmtDist(u, mi * MI_TO_KM)}`}
            unitX={distUnit(u)}
          />
        </>
      )}
    </div>
  )
}

function MetricCard({
  icon,
  title,
  blurb,
  total,
  unit,
  sub,
  points,
  accent,
  isDark,
  formatX,
  formatY,
  unitX,
}: {
  icon: string
  title: string
  blurb: string
  total: string
  unit: string
  sub: string | null
  points: ScatterPoint[]
  accent: string
  isDark: boolean
  formatX: (x: number) => string
  formatY: (y: number) => string
  unitX: string
}) {
  return (
    <Card radius={22} className="p-5">
      <span className="text-[17px] font-bold tracking-[-0.01em] text-foreground">{title}</span>
      <p className="mt-1.5 text-[12.5px] font-medium leading-[1.45] text-muted-foreground">{blurb}</p>

      <div className="mt-4 mb-3.5 flex items-center gap-[14px]">
        <div
          className="flex h-[46px] w-[46px] flex-none items-center justify-center rounded-[14px]"
          style={{ background: hexToRgba(accent, isDark ? 0.22 : 0.12) }}
        >
          <Icon d={icon} size={22} color={accent} fill={icon === ICON.battery ? accent : 'none'} stroke={icon !== ICON.battery} width={1.9} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10.5px] font-bold tracking-[0.08em] text-muted-foreground">TOTAL</span>
          <div className="flex items-baseline gap-[5px]">
            <span className="text-[34px] font-bold leading-none tracking-[-0.03em] text-foreground">{total}</span>
            <span className="text-[15px] font-semibold text-muted-foreground">{unit}</span>
          </div>
          {sub && <span className="text-xs font-medium text-muted-foreground">{sub}</span>}
        </div>
      </div>

      {points.length >= 2 ? (
        <>
          <BatteryScatter points={points} color={accent} formatX={formatX} formatY={formatY} unitX={unitX} unitY={unit} />
          <Legend accent={accent} count={points.length} />
        </>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-[14px] border border-border bg-secondary p-4 text-center">
          <span className="text-[11px] font-medium text-muted-foreground">
            Collecting readings — a couple more charges and the trend appears.
          </span>
        </div>
      )}
    </Card>
  )
}

function Legend({ accent, count }: { accent: string; count: number }): ReactNode {
  return (
    <div className="mt-3 flex items-center gap-4">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 flex-none rounded-full opacity-45" style={{ background: accent }} />
        <span className="text-[11px] font-semibold text-muted-foreground">Reading</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3.5 flex-none rounded-sm" style={{ background: accent }} />
        <span className="text-[11px] font-semibold text-muted-foreground">Trend</span>
      </span>
      <span className="ml-auto text-[11px] font-medium text-muted-foreground">{count} charge points</span>
    </div>
  )
}
