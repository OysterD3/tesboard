import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { getDriveDetail, type DriveDetailPayload } from '../../functions/drive-detail.functions'
import { exportDriveGpx } from '../../functions/export.functions'
import { buildDriveDetail, fmtClockStamp, fmtElapsedMin } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { downloadString } from '../../lib/download'
import {
  distUnit,
  effFromWhKm,
  effSuffix,
  elevUnit,
  fmtDist,
  fmtElev,
  fmtSpeed,
  fmtTemp,
  speedUnit,
  tempUnit,
} from '../../lib/units'

const EMPTY: DriveDetailPayload = { drive: null, samples: [], points: [], sampled: false, estCost: null }

export const Route = createFileRoute('/dashboard/drives_/$driveId')({
  loader: async ({ params }): Promise<DriveDetailPayload> => {
    const driveId = Number(params.driveId)
    if (!Number.isInteger(driveId) || driveId <= 0) return EMPTY
    return getDriveDetail({ data: { driveId } })
  },
  component: DriveDetailPage,
})

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives
const START_DOT = '#34c759'
const BACK = 'M15 18l-6-6 6-6'

function DriveDetailPage() {
  const payload = Route.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildDriveDetail(payload, tz)

  // Chart x = elapsed minutes from the drive start; render ticks + hover as the
  // absolute clock time instead (tz-safe via useDisplayTz).
  const startMs = payload.drive ? new Date(payload.drive.started_at).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  const fetchGpx = useServerFn(exportDriveGpx)
  const [gpxBusy, setGpxBusy] = useState(false)
  async function downloadGpx() {
    if (!payload.drive || gpxBusy) return
    setGpxBusy(true)
    try {
      const f = await fetchGpx({ data: { driveId: payload.drive.id } })
      if (f.body) downloadString(f.filename, f.mime, f.body)
    } finally {
      setGpxBusy(false)
    }
  }

  const headerTitle = vm.endPlace ? `To ${vm.endPlace}` : vm.title

  // Cost per distance unit, derived from the estimate.
  const distSel = fmtDist(u, vm.distKm, 2)
  const costPerDist =
    vm.estCost && distSel > 0 ? { amount: vm.estCost.amount / distSel, currency: vm.estCost.currency } : null

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
        <Link
          to="/dashboard/drives"
          search={(prev) => prev}
          aria-label="Back to drives"
          style={{
            width: 40,
            height: 40,
            flex: 'none',
            borderRadius: '50%',
            border: '1px solid var(--border,rgba(0,0,0,0.08))',
            background: 'var(--card,#fff)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
          }}
        >
          <Icon d={BACK} size={20} color={TX} />
        </Link>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {headerTitle}
          </span>
          {vm.found && <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{vm.subtitle}</span>}
        </div>
      </div>

      {!vm.found ? (
        <EmptyCard
          title="Drive not found"
          body="This drive doesn’t exist or isn’t one of yours. It may have been removed, or the link is stale."
        />
      ) : (
        <>
          {/* Map + GPX export */}
          {vm.hasGps && (
            <Card radius={22} style={{ padding: 14 }}>
              <LeafletMap points={payload.points} color={COLOR} isDark={isDark} height={240} />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 500, color: TD, paddingLeft: 2 }}>
                  {payload.sampled
                    ? `Sampled GPS · ${payload.points.length} points`
                    : 'Approximate (start/end only — no breadcrumb yet)'}
                </span>
                <button
                  type="button"
                  onClick={downloadGpx}
                  disabled={gpxBusy}
                  title="Download this drive as a GPX track"
                  style={{ flex: 'none', fontSize: 11, fontWeight: 600, color: COLOR, background: 'none', border: `1px solid ${COLOR}`, borderRadius: 30, padding: '5px 12px', cursor: gpxBusy ? 'default' : 'pointer', opacity: gpxBusy ? 0.6 : 1, whiteSpace: 'nowrap' }}
                >
                  {gpxBusy ? 'Exporting…' : 'Export GPX'}
                </button>
              </div>
            </Card>
          )}

          {/* Trip: From → To + distance/duration */}
          <Card radius={22} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Endpoint stamp={vm.startStamp} battery={vm.batteryStart} place={vm.startPlace} color={START_DOT} isDark={isDark} connector />
              <Endpoint stamp={vm.endStamp} battery={vm.batteryEnd} place={vm.endPlace} color={COLOR} isDark={isDark} />
            </div>
            <Divider />
            <TileRow>
              <StatTile icon={ICON.gauge} label="Distance" value={`${fmtDist(u, vm.distKm, 1)}`} unit={distUnit(u)} accent={COLOR} />
              <StatTile icon={ICON.clock} label="Duration" value={fmtElapsedMin(vm.durMin)} accent={COLOR} />
            </TileRow>
          </Card>

          {/* Costs */}
          <SectionCard title="Costs">
            <TileRow>
              <StatTile icon={ICON.charging} fill label="Electric cost" value={fmtMoney(vm.estCost)} accent={SECTION.charging} />
              <StatTile icon={ICON.dollar} label={`Cost / ${distUnit(u)}`} value={fmtMoney(costPerDist)} accent={SECTION.charging} />
            </TileRow>
          </SectionCard>

          {/* Energy */}
          <SectionCard title="Energy">
            <TileRow>
              <StatTile icon={ICON.battery} fill label="Total used" value={vm.kwh != null ? `${vm.kwh}` : DASH} unit={vm.kwh != null ? 'kWh' : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.leaf} label="Average" value={vm.effWhKm != null ? `${effFromWhKm(u, vm.effWhKm)}` : DASH} unit={vm.effWhKm != null ? effSuffix(u) : ''} accent={SECTION.insights} />
            </TileRow>
          </SectionCard>

          {/* Speed */}
          <SectionCard title="Speed">
            <TileRow>
              <StatTile icon={ICON.gauge} label="Average" value={`${fmtSpeed(u, vm.avgKph)}`} unit={speedUnit(u)} accent={COLOR} />
              <StatTile icon={ICON.gauge} label="Max" value={vm.maxKph != null ? `${fmtSpeed(u, vm.maxKph)}` : DASH} unit={vm.maxKph != null ? speedUnit(u) : ''} accent={COLOR} />
            </TileRow>
            <Chart points={vm.series.speedKph} color={COLOR} formatX={fmtX} formatY={(kph) => `${fmtSpeed(u, kph)}`} unitY={speedUnit(u)} empty="No speed samples recorded for this drive." />
          </SectionCard>

          {/* Power / regen */}
          <SectionCard title="Power">
            <TileRow>
              <StatTile icon={ICON.charging} fill label="Peak power" value={vm.peakPowerKw != null ? `${vm.peakPowerKw}` : DASH} unit={vm.peakPowerKw != null ? 'kW' : ''} accent={COLOR} />
              <StatTile icon={ICON.leaf} label="Peak regen" value={vm.peakRegenKw != null ? `${vm.peakRegenKw}` : DASH} unit={vm.peakRegenKw != null ? 'kW' : ''} accent={SECTION.insights} />
            </TileRow>
            <Chart points={vm.series.powerKw} color={COLOR} formatX={fmtX} formatY={(kw) => `${Math.round(kw)}`} unitY="kW" baseline={0} empty="No power samples recorded for this drive (regen needs denser data than 2-min polling)." />
          </SectionCard>

          {/* Battery */}
          <SectionCard title="Battery">
            <TileRow>
              <StatTile
                icon={ICON.battery}
                fill
                glyph={vm.batteryStart != null ? <BatteryGlyph pct={vm.batteryStart} color={COLOR} /> : undefined}
                label="Start"
                value={vm.batteryStart != null ? `${vm.batteryStart}` : DASH}
                unit={vm.batteryStart != null ? '%' : ''}
                accent={COLOR}
              />
              <StatTile
                icon={ICON.battery}
                fill
                glyph={vm.batteryEnd != null ? <BatteryGlyph pct={vm.batteryEnd} color={COLOR} /> : undefined}
                label="End"
                value={vm.batteryEnd != null ? `${vm.batteryEnd}` : DASH}
                unit={vm.batteryEnd != null ? '%' : ''}
                accent={COLOR}
              />
            </TileRow>
            <Chart points={vm.series.battery} color={COLOR} formatX={fmtX} formatY={(pct) => `${Math.round(pct)}`} unitY="%" empty="No battery readings recorded for this drive." />
          </SectionCard>

          {/* Elevation */}
          <SectionCard title="Elevation">
            <TileRow>
              <StatTile icon={ICON.analytics} label="Total" value={vm.ascentM != null ? `+${fmtElev(u, vm.ascentM)}` : DASH} unit={vm.ascentM != null ? elevUnit(u) : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.mountain} label="Peak" value={vm.peakElevM != null ? `${fmtElev(u, vm.peakElevM)}` : DASH} unit={vm.peakElevM != null ? elevUnit(u) : ''} accent={SECTION.insights} />
            </TileRow>
            <Chart points={vm.series.elevationM} color={SECTION.insights} formatX={fmtX} formatY={(m) => `${fmtElev(u, m)}`} unitY={elevUnit(u)} empty="No elevation for this drive (no GPS fixes recorded, or the lookup was unavailable)." />
          </SectionCard>

          {/* Range efficiency */}
          <SectionCard title="Range efficiency">
            <TileRow>
              <StatTile icon={ICON.battery} fill label="Used" value={vm.ratedUsedKm != null ? `${fmtDist(u, vm.ratedUsedKm, 1)}` : DASH} unit={vm.ratedUsedKm != null ? distUnit(u) : ''} accent={SECTION.insights} />
              <StatTile icon={ICON.leaf} label="Efficiency" value={vm.rangeEffPct != null ? `${vm.rangeEffPct}` : DASH} unit={vm.rangeEffPct != null ? '%' : ''} accent={SECTION.insights} />
            </TileRow>
          </SectionCard>

          {/* Cabin temperatures */}
          <SectionCard title="Interior temperature">
            <StatTile icon={ICON.thermometer} label="Average" value={vm.insideAvgC != null ? `${fmtTemp(u, vm.insideAvgC)}` : DASH} unit={vm.insideAvgC != null ? tempUnit(u) : ''} accent={SECTION.charging} />
            <Chart points={vm.series.insideC} color={SECTION.charging} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="No interior-temperature samples for this drive." />
          </SectionCard>

          <SectionCard title="Exterior temperature">
            <StatTile icon={ICON.thermometer} label="Average" value={vm.outsideAvgC != null ? `${fmtTemp(u, vm.outsideAvgC)}` : DASH} unit={vm.outsideAvgC != null ? tempUnit(u) : ''} accent={SECTION.analytics} />
            <Chart points={vm.series.outsideC} color={SECTION.analytics} formatX={fmtX} formatY={(c) => `${fmtTemp(u, c)}`} unitY={tempUnit(u)} empty="No exterior-temperature samples for this drive." />
          </SectionCard>
        </>
      )}
    </div>
  )
}

/** One end of the trip: pin + "stamp · battery%" over a bold place name. The
 *  start endpoint draws a dotted connector down toward the end pin. */
function Endpoint({
  stamp,
  battery,
  place,
  color,
  isDark,
  connector = false,
}: {
  stamp: string | null
  battery: number | null
  place: string | null
  color: string
  isDark: boolean
  connector?: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', paddingTop: 2 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba(color, isDark ? 0.24 : 0.14),
          }}
        >
          <Icon d={ICON.pin} size={16} color={color} />
        </span>
        {connector && (
          <span style={{ flex: 1, marginTop: 5, marginBottom: -3, minHeight: 16, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, paddingBottom: connector ? 18 : 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: TD, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stamp || '—'}</span>
          {battery != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' }}>
              <span>·</span>
              <BatteryGlyph pct={battery} color={color} size={17} />
              <span>{battery}%</span>
            </span>
          )}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {place ?? 'Unknown location'}
        </span>
      </div>
    </div>
  )
}
