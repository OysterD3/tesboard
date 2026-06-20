import { Link, createFileRoute } from '@tanstack/react-router'
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { getIdleDetail, type IdleDetailPayload } from '../../functions/idle-detail.functions'
import { buildIdleDetail, fmtIdleDuration } from '../../lib/idles-vm'
import { fmtClockStamp } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { distUnit, fmtDist, fmtTemp, tempUnit } from '../../lib/units'

const EMPTY: IdleDetailPayload = {
  found: false,
  prevDriveId: 0,
  vin: null,
  startedAt: null,
  endedAt: null,
  place: null,
  point: null,
  startBattery: null,
  endBattery: null,
  startRangeMi: null,
  endRangeMi: null,
  effWhPerMi: null,
  packKwh: null,
  chargerKwh: null,
  cost: null,
  states: [],
  samples: [],
}

export const Route = createFileRoute('/dashboard/idles_/$idleId')({
  loader: async ({ params }): Promise<IdleDetailPayload> => {
    const prevDriveId = Number(params.idleId)
    if (!Number.isInteger(prevDriveId) || prevDriveId <= 0) return EMPTY
    return getIdleDetail({ data: { prevDriveId } })
  },
  component: IdleDetailPage,
})

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.idles
const BACK = 'M15 18l-6-6 6-6'

function IdleDetailPage() {
  const payload = Route.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildIdleDetail(payload, tz)

  const startMs = payload.startedAt ? new Date(payload.startedAt).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
        <Link
          to="/dashboard/idles"
          search={(prev) => prev}
          aria-label="Back to idles"
          style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', border: '1px solid var(--border,rgba(0,0,0,0.08))', background: 'var(--card,#fff)', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
        >
          <Icon d={BACK} size={20} color={TX} />
        </Link>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {vm.title}
          </span>
          {vm.found && <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{vm.subtitle}</span>}
        </div>
      </div>

      {!vm.found ? (
        <EmptyCard
          title="Idle not found"
          body="This parked period doesn’t exist or isn’t one of yours. It needs a drive on each side, so it may not have closed yet."
        />
      ) : (
        <>
          {/* Map */}
          {vm.hasMap && payload.point && (
            <Card radius={22} style={{ padding: 14 }}>
              <LeafletMap points={[payload.point]} color={COLOR} isDark={isDark} mode="scatter" height={240} />
            </Card>
          )}

          {/* Session: parking icon + place, parked → drove off battery, duration / cost */}
          <Card radius={22} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexToRgba(COLOR, isDark ? 0.24 : 0.13) }}>
                <Icon d={ICON.parking} size={19} color={COLOR} width={1.9} />
              </span>
              <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {vm.place ?? 'Parked'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
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
    <div style={{ display: 'flex', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', paddingTop: 2 }}>
        <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexToRgba(COLOR, isDark ? 0.24 : 0.13) }}>
          {battery != null ? <BatteryGlyph pct={battery} color={COLOR} size={18} /> : <Icon d={ICON.battery} size={15} color={COLOR} />}
        </span>
        {connector && (
          <span style={{ flex: 1, marginTop: 5, marginBottom: -3, minHeight: 16, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingBottom: connector ? 16 : 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}{stamp ? ` · ${stamp}` : ''}
        </span>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>
          {battery != null ? `${battery}%` : DASH}
        </span>
      </div>
    </div>
  )
}
