import { createFileRoute } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BackHeader, BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { chargeDetailQuery } from '../../lib/queries'
import { setChargeCost } from '../../functions/charging.functions'
import { buildChargeDetail } from '../../lib/charge-detail-vm'
import { fmtClockStamp } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { distUnit, fmtDist, fmtTemp, tempUnit } from '../../lib/units'
import { fmtDurMin } from '../../lib/format'
import { cn } from '../../lib/utils'

export const Route = createFileRoute('/dashboard/charging_/$chargeId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(chargeDetailQuery(Number(params.chargeId))),
  component: ChargeDetailPage,
})

const COLOR = SECTION.charging

function ChargeDetailPage() {
  const payload = useSuspenseQuery(chargeDetailQuery(Number(Route.useParams().chargeId))).data
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildChargeDetail(payload, tz)

  const startMs = payload.charge ? new Date(payload.charge.started_at).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  // Cost edit (moved here from the list, now that tapping a row opens this page).
  const queryClient = useQueryClient()
  const saveCost = useMutation({
    mutationFn: (vars: { id: number; cost: number | null; currency: string }) => setChargeCost({ data: vars }),
    onSuccess: () => {
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['chargeDetail'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
  const saving = saveCost.isPending
  const [editing, setEditing] = useState(false)
  const [costInput, setCostInput] = useState('')
  function openEditor() {
    setCostInput(vm.cost ? String(vm.cost.amount) : '')
    setEditing(true)
  }
  function submitCost(value: number | null) {
    if (!payload.charge) return
    saveCost.mutate({ id: payload.charge.id, cost: value, currency: vm.cost?.currency ?? 'USD' })
  }

  return (
    <div className="evd-view flex flex-col gap-[14px]">
      <BackHeader
        to="/dashboard/charging"
        title={vm.title}
        subtitle={vm.found ? `${vm.subtitle} · ${vm.typeLabel}` : undefined}
      />

      {!vm.found ? (
        <EmptyCard
          title="Charge not found"
          body="This charge session doesn’t exist or isn’t one of yours. It may have been removed, or the link is stale."
        />
      ) : (
        <>
          {/* Map */}
          {vm.hasMap && payload.point && (
            <Card radius={22} className="p-[14px]">
              <LeafletMap points={[payload.point]} color={COLOR} isDark={isDark} mode="scatter" height={240} />
            </Card>
          )}

          {/* Session: charge icon + place, From → To battery, cost / odometer / since / duration */}
          <Card radius={22} className="flex flex-col gap-4 p-[18px]">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex h-[38px] w-[38px] flex-none items-center justify-center rounded-full"
                style={{ background: hexToRgba(COLOR, isDark ? 0.22 : 0.12) }}
              >
                <Icon d={ICON.charging} size={19} color={COLOR} fill={COLOR} stroke={false} />
              </span>
              <span className="truncate text-base font-bold tracking-[-0.01em] text-foreground">
                {vm.place ?? 'Charge session'}
              </span>
            </div>
            <div className="flex flex-col">
              <ChargeEnd stamp={vm.startStamp} battery={vm.batteryStart} isDark={isDark} connector />
              <ChargeEnd stamp={vm.endStamp} battery={vm.batteryEnd} isDark={isDark} />
            </div>
            <Divider />
            <TileRow>
              <button type="button" onClick={openEditor} className="min-w-0 cursor-pointer border-none bg-transparent p-0 text-left" title="Tap to edit cost">
                <StatTile icon={ICON.charging} fill label={vm.costSource === 'manual' ? 'Electric cost · edited' : 'Electric cost · tap'} value={fmtMoney(vm.cost)} accent={COLOR} />
              </button>
              <StatTile icon={ICON.clock} label="Duration" value={fmtDurMin(vm.durMin)} accent={COLOR} />
            </TileRow>
            {(vm.odometerKm != null || vm.sinceLastChargeKm != null) && (
              <Tiles>
                {vm.odometerKm != null && <StatTile icon={ICON.gauge} label="Odometer" value={`${fmtDist(u, vm.odometerKm, 2)}`} unit={distUnit(u)} accent={COLOR} />}
                {vm.sinceLastChargeKm != null && <StatTile icon={ICON.road} label="Since last charge" value={`${fmtDist(u, vm.sinceLastChargeKm, 2)}`} unit={distUnit(u)} accent={COLOR} />}
              </Tiles>
            )}

            {editing && (
              <div className="flex items-center gap-2 border-t border-border pt-[14px]">
                <span className="text-[13px] font-semibold text-muted-foreground">{vm.cost?.currency ?? 'USD'}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  autoFocus
                  placeholder="0.00"
                  className="min-w-0 flex-1 rounded-[10px] border border-border bg-secondary px-3 py-2 text-[15px] font-semibold text-foreground"
                />
                <button
                  type="button"
                  disabled={saving || costInput.trim() === '' || !(Number(costInput) >= 0)}
                  onClick={() => submitCost(Number(costInput))}
                  style={{ background: COLOR }}
                  className={cn('rounded-[10px] border-none px-[14px] py-2 text-[13px] font-semibold text-white', saving ? 'cursor-default opacity-60' : 'cursor-pointer opacity-100')}
                >
                  Save
                </button>
                {vm.costSource === 'manual' && (
                  <button type="button" disabled={saving} onClick={() => submitCost(null)} title="Revert to automatic costing" className="cursor-pointer rounded-[10px] border border-border bg-secondary px-3 py-2 text-[13px] font-semibold text-muted-foreground">
                    Auto
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => setEditing(false)} className="cursor-pointer border-none bg-transparent px-1 py-2 text-[13px] font-semibold text-muted-foreground">
                  Cancel
                </button>
              </div>
            )}
          </Card>

          {/* Energy — only the tiles/chart we actually have data for. */}
          {(vm.addedKwh != null || vm.usedKwh != null || vm.effPct != null || vm.series.soc.length >= 2) && (
            <SectionCard title="Energy">
              <Tiles>
                {vm.usedKwh != null && <StatTile icon={ICON.plug} label="Total used" value={`${vm.usedKwh}`} unit="kWh" accent={COLOR} />}
                {vm.addedKwh != null && <StatTile icon={ICON.battery} fill label="Total added" value={`${vm.addedKwh}`} unit="kWh" accent={SECTION.insights} />}
              </Tiles>
              {vm.effPct != null && <StatTile icon={ICON.leaf} label="Efficiency" value={`${vm.effPct}`} unit="%" accent={SECTION.insights} />}
              {vm.series.soc.length >= 2 && (
                <Chart points={vm.series.soc} color={COLOR} formatX={fmtX} formatY={(pct) => `${Math.round(pct)}`} unitY="%" empty="" />
              )}
            </SectionCard>
          )}

          {/* Range */}
          {(vm.rangeAddedKm != null || vm.series.rangeKm.length >= 2) && (
            <SectionCard title="Range">
              {vm.rangeAddedKm != null && (
                <StatTile icon={ICON.battery} fill label="Total added" value={`${fmtDist(u, vm.rangeAddedKm, 1)}`} unit={distUnit(u)} accent={SECTION.insights} />
              )}
              {vm.series.rangeKm.length >= 2 && (
                <Chart points={vm.series.rangeKm} color={SECTION.drives} formatX={fmtX} formatY={(km) => `${fmtDist(u, km, 0)}`} unitY={distUnit(u)} empty="" />
              )}
            </SectionCard>
          )}

          {/* Power (shown as a positive charging magnitude) */}
          {vm.powerPeakKw != null && (
            <SectionCard title="Power">
              <TileRow>
                <StatTile icon={ICON.trending} label="Average" value={`${vm.powerAvgKw}`} unit="kW" accent={COLOR} />
                <StatTile icon={ICON.charging} fill label="Peak" value={`${vm.powerPeakKw}`} unit="kW" accent={COLOR} />
              </TileRow>
              {vm.series.powerKw.length >= 2 && (
                <Chart points={vm.series.powerKw} color={COLOR} formatX={fmtX} formatY={(kw) => `${Math.round(kw)}`} unitY="kW" empty="" />
              )}
            </SectionCard>
          )}

          {/* Amperage */}
          {vm.currentPeakA != null && (
            <SectionCard title="Amperage">
              <TileRow>
                <StatTile icon={ICON.trending} label="Average" value={`${vm.currentAvgA}`} unit="A" accent={COLOR} />
                <StatTile icon={ICON.charging} fill label="Peak" value={`${vm.currentPeakA}`} unit="A" accent={COLOR} />
              </TileRow>
              {vm.series.currentA.length >= 2 && (
                <Chart points={vm.series.currentA} color={SECTION.drives} formatX={fmtX} formatY={(a) => `${Math.round(a)}`} unitY="A" empty="" />
              )}
            </SectionCard>
          )}

          {/* Voltage */}
          {vm.voltagePeakV != null && (
            <SectionCard title="Voltage">
              <TileRow>
                <StatTile icon={ICON.trending} label="Average" value={`${vm.voltageAvgV}`} unit="V" accent={COLOR} />
                <StatTile icon={ICON.charging} fill label="Peak" value={`${vm.voltagePeakV}`} unit="V" accent={COLOR} />
              </TileRow>
              {vm.series.voltageV.length >= 2 && (
                <Chart points={vm.series.voltageV} color={SECTION.drives} formatX={fmtX} formatY={(v) => `${Math.round(v)}`} unitY="V" empty="" />
              )}
            </SectionCard>
          )}

          {/* Interior temperature */}
          {(vm.insideAvgC != null || vm.series.insideC.length >= 2) && (
            <SectionCard title="Interior temperature">
              {vm.insideAvgC != null && (
                <StatTile icon={ICON.thermometer} label="Average" value={`${fmtTemp(u, vm.insideAvgC)}`} unit={tempUnit(u)} accent={SECTION.charging} />
              )}
              {vm.series.insideC.length >= 2 && (
                <Chart points={vm.series.insideC} color={SECTION.charging} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="" />
              )}
            </SectionCard>
          )}

          {/* Exterior temperature */}
          {(vm.outsideAvgC != null || vm.series.outsideC.length >= 2) && (
            <SectionCard title="Exterior temperature">
              {vm.outsideAvgC != null && (
                <StatTile icon={ICON.thermometer} label="Average" value={`${fmtTemp(u, vm.outsideAvgC)}`} unit={tempUnit(u)} accent={SECTION.analytics} />
              )}
              {vm.series.outsideC.length >= 2 && (
                <Chart points={vm.series.outsideC} color={SECTION.analytics} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="" />
              )}
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

/** One end of the charge: pin + timestamp over a bold SOC%. The start endpoint
 *  draws a dotted connector down toward the end pin. */
function ChargeEnd({
  stamp,
  battery,
  isDark,
  connector = false,
}: {
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
          style={{ background: hexToRgba(COLOR, isDark ? 0.22 : 0.12) }}
        >
          {battery != null ? <BatteryGlyph pct={battery} color={COLOR} size={18} /> : <Icon d={ICON.battery} size={15} color={COLOR} />}
        </span>
        {connector && (
          <span className="mt-[5px] mb-[-3px] min-h-4 flex-1 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-0.5', connector && 'pb-4')}>
        <span className="truncate text-[11.5px] font-semibold text-muted-foreground">
          {stamp || '—'}
        </span>
        <span className="text-[17px] font-bold tracking-[-0.02em] text-foreground">
          {battery != null ? `${battery}%` : DASH}
        </span>
      </div>
    </div>
  )
}
