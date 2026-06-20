import { createFileRoute } from '@tanstack/react-router'
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useSuspenseQuery } from '@tanstack/react-query'
import { BackHeader, BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { cn } from '../../lib/utils'
import { idleDetailQuery } from '../../lib/queries'
import { buildIdleDetail, fmtIdleDuration } from '../../lib/idles-vm'
import { fmtClockStamp } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { distUnit, fmtDist, fmtTemp, tempUnit } from '../../lib/units'

export const Route = createFileRoute('/dashboard/idles_/$idleId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(idleDetailQuery(Number(params.idleId))),
  component: IdleDetailPage,
})

const COLOR = SECTION.idles

function IdleDetailPage() {
  const payload = useSuspenseQuery(idleDetailQuery(Number(Route.useParams().idleId))).data
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildIdleDetail(payload, tz)

  const startMs = payload.startedAt ? new Date(payload.startedAt).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  return (
    <div className="evd-view flex flex-col gap-[14px]">
      <BackHeader to="/dashboard/idles" title={vm.title} subtitle={vm.found ? vm.subtitle : undefined} />

      {!vm.found ? (
        <EmptyCard
          title="Idle not found"
          body="This parked period doesn’t exist or isn’t one of yours. It needs a drive on each side, so it may not have closed yet."
        />
      ) : (
        <>
          {/* Map */}
          {vm.hasMap && payload.point && (
            <Card radius={22} className="p-[14px]">
              <LeafletMap points={[payload.point]} color={COLOR} isDark={isDark} mode="scatter" height={240} />
            </Card>
          )}

          {/* Session: parking icon + place, parked → drove off battery, duration / cost */}
          <Card radius={22} className="flex flex-col gap-4 p-[18px]">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[11px]"
                style={{ background: hexToRgba(COLOR, isDark ? 0.24 : 0.13) }}
              >
                <Icon d={ICON.parking} size={19} color={COLOR} width={1.9} />
              </span>
              <span className="truncate text-base font-bold tracking-[-0.01em] text-foreground">
                {vm.place ?? 'Parked'}
              </span>
            </div>
            <div className="flex flex-col">
              <IdleEnd label="Parked" stamp={vm.startStamp} battery={vm.batteryStart} isDark={isDark} connector />
              <IdleEnd label="Drove off" stamp={vm.endStamp} battery={vm.batteryEnd} isDark={isDark} />
            </div>
            <Divider />
            <TileRow>
              <StatTile icon={ICON.clock} label="Duration" value={fmtIdleDuration(vm.durMin)} accent={COLOR} />
              <StatTile icon={ICON.charging} fill label="Electric cost" value={fmtMoney(vm.cost)} accent={SECTION.charging} />
            </TileRow>
          </Card>

          {/* Energy usage — asleep share + battery drain + any charger energy */}
          {(vm.asleepPct != null || vm.batteryKwh != null || vm.chargerKwh != null || vm.series.soc.length >= 2) && (
            <SectionCard title="Energy usage">
              <Tiles>
                {vm.asleepPct != null && <StatTile icon={ICON.moon} fill label="Asleep" value={`${vm.asleepPct}`} unit="%" accent={COLOR} />}
                {vm.batteryKwh != null && <StatTile icon={ICON.battery} fill label="Battery" value={`${vm.batteryKwh}`} unit="kWh" accent={COLOR} />}
                {vm.chargerKwh != null && <StatTile icon={ICON.plug} label="Charger" value={`${vm.chargerKwh}`} unit="kWh" accent={SECTION.charging} />}
              </Tiles>
              {vm.series.soc.length >= 2 && (
                <Chart points={vm.series.soc} color={COLOR} formatX={fmtX} formatY={(pct) => `${Math.round(pct)}`} unitY="%" empty="" />
              )}
            </SectionCard>
          )}

          {/* Range */}
          {(vm.rangeUsedKm != null || vm.series.rangeKm.length >= 2) && (
            <SectionCard title="Range">
              {vm.rangeUsedKm != null && (
                <StatTile icon={ICON.battery} label="Total used" value={`${fmtDist(u, vm.rangeUsedKm, 2)}`} unit={distUnit(u)} accent={COLOR} />
              )}
              {vm.series.rangeKm.length >= 2 && (
                <Chart points={vm.series.rangeKm} color={SECTION.drives} formatX={fmtX} formatY={(km) => `${fmtDist(u, km, 0)}`} unitY={distUnit(u)} empty="" />
              )}
            </SectionCard>
          )}

          {/* Power — only present when a charge ran during the park */}
          {vm.series.powerKw.length >= 2 && (
            <SectionCard title="Power">
              <Chart points={vm.series.powerKw} color={SECTION.charging} formatX={fmtX} formatY={(kw) => `${Math.round(kw)}`} unitY="kW" empty="" baseline={0} />
            </SectionCard>
          )}

          {/* Interior temperature */}
          {vm.series.insideC.length >= 2 && (
            <SectionCard title="Interior temperature">
              <Chart points={vm.series.insideC} color={SECTION.charging} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="" />
            </SectionCard>
          )}

          {/* Exterior temperature */}
          {vm.series.outsideC.length >= 2 && (
            <SectionCard title="Exterior temperature">
              <Chart points={vm.series.outsideC} color={SECTION.analytics} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="" />
            </SectionCard>
          )}
        </>
      )}
    </div>
  )
}

/** Render only the present stat tiles: one tile full-width, or two-up in a grid. */
function Tiles({ children }: { children: ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean) as ReactNode[]
  if (items.length === 0) return null
  const keyed = items.map((it, i) => <Fragment key={i}>{it}</Fragment>)
  return items.length === 1 ? <>{keyed}</> : <TileRow>{keyed}</TileRow>
}

/** One end of the idle: parked battery glyph + label/timestamp over a bold SOC%.
 *  The start endpoint draws a dotted connector down toward the end pin. */
function IdleEnd({
  label,
  stamp,
  battery,
  isDark,
  connector = false,
}: {
  label: string
  stamp: string | null
  battery: number | null
  isDark: boolean
  connector?: boolean
}) {
  return (
    <div className="flex min-w-0 gap-[14px]">
      <div className="flex flex-none flex-col items-center pt-0.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-full"
          style={{ background: hexToRgba(COLOR, isDark ? 0.24 : 0.13) }}
        >
          {battery != null ? <BatteryGlyph pct={battery} color={COLOR} size={18} /> : <Icon d={ICON.battery} size={15} color={COLOR} />}
        </span>
        {connector && (
          <span className="mt-[5px] mb-[-3px] min-h-4 flex-1 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-0.5', connector && 'pb-4')}>
        <span className="truncate text-[11.5px] font-semibold text-muted-foreground">
          {label}{stamp ? ` · ${stamp}` : ''}
        </span>
        <span className="text-[17px] font-bold tracking-[-0.02em] text-foreground">
          {battery != null ? `${battery}%` : DASH}
        </span>
      </div>
    </div>
  )
}
