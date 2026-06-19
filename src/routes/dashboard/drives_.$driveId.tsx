import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { SeriesChart, type SeriesPoint } from '../../components/dashboard/SeriesChart'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { SECTION } from '../../components/dashboard/theme'
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
  type Units,
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
const BACK = 'M15 18l-6-6 6-6'

function DriveDetailPage() {
  const payload = Route.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildDriveDetail(payload, tz)

  // Chart x = elapsed minutes from the drive start; render the ticks + hover
  // readout as the absolute clock time instead (tz-safe via useDisplayTz).
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

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
        <Link
          to="/dashboard/drives"
          search={(prev) => prev}
          aria-label="Back to drives"
          style={{
            width: 38,
            height: 38,
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
          <span
            style={{
              fontSize: 21,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: TX,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {vm.title}
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
              <LeafletMap points={payload.points} color={COLOR} isDark={isDark} />
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
                  style={{
                    flex: 'none',
                    fontSize: 11,
                    fontWeight: 600,
                    color: COLOR,
                    background: 'none',
                    border: `1px solid ${COLOR}`,
                    borderRadius: 30,
                    padding: '5px 12px',
                    cursor: gpxBusy ? 'default' : 'pointer',
                    opacity: gpxBusy ? 0.6 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {gpxBusy ? 'Exporting…' : 'Export GPX'}
                </button>
              </div>
            </Card>
          )}

          {/* From → To */}
          {(vm.startPlace || vm.endPlace) && (
            <Card radius={20} style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Endpoint label="From" place={vm.startPlace} dot="#34c759" />
              <Endpoint label="To" place={vm.endPlace} dot={COLOR} />
            </Card>
          )}

          {/* Headline stats */}
          <Card radius={22} style={{ padding: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', rowGap: 18, columnGap: 8 }}>
              <Stat value={`${fmtDist(u, vm.distKm, 1)}`} unit={distUnit(u)} label="Distance" />
              <Stat value={fmtElapsedMin(vm.durMin)} label="Duration" />
              <Stat value={`${fmtSpeed(u, vm.avgKph)}`} unit={speedUnit(u)} label="Avg speed" />
              <Stat value={vm.maxKph != null ? `${fmtSpeed(u, vm.maxKph)}` : '—'} unit={vm.maxKph != null ? speedUnit(u) : ''} label="Max speed" />
              <Stat value={vm.kwh != null ? `${vm.kwh}` : '—'} unit={vm.kwh != null ? 'kWh' : ''} label="Energy" />
              <Stat
                value={vm.effWhKm != null ? `${effFromWhKm(u, vm.effWhKm)}` : '—'}
                unit={vm.effWhKm != null ? effSuffix(u) : ''}
                label="Efficiency"
              />
              <Stat
                value={vm.batteryStart != null && vm.batteryEnd != null ? `${vm.batteryStart}→${vm.batteryEnd}` : '—'}
                unit={vm.batteryStart != null && vm.batteryEnd != null ? '%' : ''}
                label="Battery"
              />
              <Stat value={fmtMoney(vm.estCost)} label="Est. cost" />
              <Stat
                value={vm.ascentM != null ? `${fmtElev(u, vm.ascentM)}` : '—'}
                unit={vm.ascentM != null ? elevUnit(u) : ''}
                label="Elevation ↑"
              />
            </div>
          </Card>

          {/* Charts */}
          <ChartCard
            title="Battery"
            subtitle={vm.batteryStart != null && vm.batteryEnd != null ? `${vm.batteryStart}% → ${vm.batteryEnd}%` : null}
            points={vm.series.battery}
            color={COLOR}
            formatX={fmtX}
            formatY={(pct) => `${Math.round(pct)}`}
            unitY="%"
            empty="No battery readings recorded for this drive."
          />
          <ChartCard
            title="Speed"
            subtitle={vm.maxKph != null ? `max ${fmtSpeed(u, vm.maxKph)} ${speedUnit(u)}` : null}
            points={vm.series.speedKph}
            color={COLOR}
            formatX={fmtX}
            formatY={(kph) => `${fmtSpeed(u, kph)}`}
            unitY={speedUnit(u)}
            empty="No speed samples recorded for this drive."
          />
          <ChartCard
            title="Elevation"
            subtitle={elevationSubtitle(vm, u)}
            points={vm.series.elevationM}
            color={SECTION.insights}
            formatX={fmtX}
            formatY={(m) => `${fmtElev(u, m)}`}
            unitY={elevUnit(u)}
            empty="No elevation data for this drive (elevation comes from imported trips)."
          />
          <ChartCard
            title="Interior temperature"
            subtitle={vm.insideAvgC != null ? `avg ${fmtTemp(u, vm.insideAvgC)} ${tempUnit(u)}` : null}
            points={vm.series.insideC}
            color={SECTION.charging}
            formatX={fmtX}
            formatY={(c) => `${fmtTemp(u, c)}`}
            unitY={tempUnit(u)}
            empty="No interior-temperature samples for this drive."
          />
          <ChartCard
            title="Exterior temperature"
            subtitle={vm.outsideAvgC != null ? `avg ${fmtTemp(u, vm.outsideAvgC)} ${tempUnit(u)}` : null}
            points={vm.series.outsideC}
            color={SECTION.analytics}
            formatX={fmtX}
            formatY={(c) => `${fmtTemp(u, c)}`}
            unitY={tempUnit(u)}
            empty="No exterior-temperature samples for this drive."
          />
        </>
      )}
    </div>
  )
}

function elevationSubtitle(vm: ReturnType<typeof buildDriveDetail>, u: Units): string | null {
  const parts: string[] = []
  if (vm.ascentM != null) parts.push(`↑ ${fmtElev(u, vm.ascentM)} ${elevUnit(u)}`)
  if (vm.descentM != null) parts.push(`↓ ${fmtElev(u, vm.descentM)} ${elevUnit(u)}`)
  if (vm.peakElevM != null) parts.push(`peak ${fmtElev(u, vm.peakElevM)} ${elevUnit(u)}`)
  return parts.length ? parts.join(' · ') : null
}

/** "$1.84" for USD, "1.84 EUR" otherwise; "—" when there's no rate to estimate from. */
function fmtMoney(c: { amount: number; currency: string } | null): string {
  if (!c) return '—'
  const n = c.amount.toFixed(2)
  return c.currency === 'USD' ? `$${n}` : `${n} ${c.currency}`
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>{value}</span>
        {unit ? <span style={{ fontSize: 12, fontWeight: 600, color: TD }}>{unit}</span> : null}
      </div>
      <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>{label}</span>
    </div>
  )
}

function Endpoint({ label, place, dot }: { label: string; place: string | null; dot: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, flex: 'none' }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: TD, width: 46, flex: 'none', whiteSpace: 'nowrap' }}>
        {label.toUpperCase()}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: TX,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {place ?? 'Unknown location'}
      </span>
    </div>
  )
}

function ChartCard({
  title,
  subtitle,
  points,
  color,
  formatX,
  formatY,
  unitY,
  empty,
}: {
  title: string
  subtitle: string | null
  points: SeriesPoint[]
  color: string
  formatX: (x: number) => string
  formatY: (y: number) => string
  unitY: string
  empty: string
}): ReactNode {
  return (
    <Card radius={20} style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{title}</span>
        {subtitle && <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{subtitle}</span>}
      </div>
      {points.length >= 2 ? (
        <SeriesChart points={points} color={color} formatX={formatX} formatY={formatY} unitY={unitY} />
      ) : (
        <div
          style={{
            height: 96,
            borderRadius: 14,
            border: '1px solid var(--border,rgba(0,0,0,0.07))',
            background: 'var(--track,#f7f7f9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: 16,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>{empty}</span>
        </div>
      )}
    </Card>
  )
}
