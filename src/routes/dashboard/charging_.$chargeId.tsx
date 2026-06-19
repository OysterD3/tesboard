import { Link, createFileRoute } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { BatteryGlyph, Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { Chart, DASH, Divider, SectionCard, StatTile, TileRow, fmtMoney } from '../../components/dashboard/detail'
import { LeafletMap } from '../../components/dashboard/LeafletMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, hexToRgba } from '../../components/dashboard/theme'
import { getChargeSessionDetail, type ChargeDetailPayload } from '../../functions/charge-detail.functions'
import { setChargeCost } from '../../functions/charging.functions'
import { buildChargeDetail } from '../../lib/charge-detail-vm'
import { fmtClockStamp } from '../../lib/drive-detail-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { distUnit, fmtDist, fmtTemp, tempUnit } from '../../lib/units'

const EMPTY: ChargeDetailPayload = { charge: null, samples: [], point: null, odometerMi: null, sinceLastChargeMi: null }

export const Route = createFileRoute('/dashboard/charging_/$chargeId')({
  loader: async ({ params }): Promise<ChargeDetailPayload> => {
    const sessionId = Number(params.chargeId)
    if (!Number.isInteger(sessionId) || sessionId <= 0) return EMPTY
    return getChargeSessionDetail({ data: { sessionId } })
  },
  component: ChargeDetailPage,
})

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.charging
const BACK = 'M15 18l-6-6 6-6'

function ChargeDetailPage() {
  const payload = Route.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const tz = useDisplayTz()
  const vm = buildChargeDetail(payload, tz)

  const startMs = payload.charge ? new Date(payload.charge.started_at).getTime() : 0
  const fmtX = (min: number) => fmtClockStamp(startMs + min * 60000, tz)

  // Cost edit (moved here from the list, now that tapping a row opens this page).
  const router = useRouter()
  const saveCost = useServerFn(setChargeCost)
  const [editing, setEditing] = useState(false)
  const [costInput, setCostInput] = useState('')
  const [saving, setSaving] = useState(false)
  function openEditor() {
    setCostInput(vm.cost ? String(vm.cost.amount) : '')
    setEditing(true)
  }
  async function submitCost(value: number | null) {
    if (!payload.charge) return
    setSaving(true)
    try {
      await saveCost({ data: { id: payload.charge.id, cost: value, currency: vm.cost?.currency ?? 'USD' } })
      setEditing(false)
      await router.invalidate()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
        <Link
          to="/dashboard/charging"
          search={(prev) => prev}
          aria-label="Back to charging"
          style={{ width: 40, height: 40, flex: 'none', borderRadius: '50%', border: '1px solid var(--border,rgba(0,0,0,0.08))', background: 'var(--card,#fff)', display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
        >
          <Icon d={BACK} size={20} color={TX} />
        </Link>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {vm.title}
          </span>
          {vm.found && <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{vm.subtitle} · {vm.typeLabel}</span>}
        </div>
      </div>

      {!vm.found ? (
        <EmptyCard
          title="Charge not found"
          body="This charge session doesn’t exist or isn’t one of yours. It may have been removed, or the link is stale."
        />
      ) : (
        <>
          {/* Map */}
          {vm.hasMap && payload.point && (
            <Card radius={22} style={{ padding: 14 }}>
              <LeafletMap points={[payload.point]} color={COLOR} isDark={isDark} mode="scatter" height={240} />
            </Card>
          )}

          {/* Session: charge icon + place, From → To battery, cost / odometer / since / duration */}
          <Card radius={22} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span style={{ width: 38, height: 38, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexToRgba(COLOR, isDark ? 0.22 : 0.12) }}>
                <Icon d={ICON.charging} size={19} color={COLOR} fill={COLOR} stroke={false} />
              </span>
              <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {vm.place ?? 'Charge session'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ChargeEnd stamp={vm.startStamp} battery={vm.batteryStart} isDark={isDark} connector />
              <ChargeEnd stamp={vm.endStamp} battery={vm.batteryEnd} isDark={isDark} />
            </div>
            <Divider />
            <TileRow>
              <button type="button" onClick={openEditor} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0 }} title="Tap to edit cost">
                <StatTile icon={ICON.charging} fill label={vm.costSource === 'manual' ? 'Electric cost · edited' : 'Electric cost · tap'} value={fmtMoney(vm.cost)} accent={COLOR} />
              </button>
              <StatTile icon={ICON.clock} label="Duration" value={fmtDuration(vm.durMin)} accent={COLOR} />
            </TileRow>
            {(vm.odometerKm != null || vm.sinceLastChargeKm != null) && (
              <Tiles>
                {vm.odometerKm != null && <StatTile icon={ICON.gauge} label="Odometer" value={`${fmtDist(u, vm.odometerKm, 2)}`} unit={distUnit(u)} accent={COLOR} />}
                {vm.sinceLastChargeKm != null && <StatTile icon={ICON.road} label="Since last charge" value={`${fmtDist(u, vm.sinceLastChargeKm, 2)}`} unit={distUnit(u)} accent={COLOR} />}
              </Tiles>
            )}

            {editing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: TD }}>{vm.cost?.currency ?? 'USD'}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={costInput}
                  onChange={(e) => setCostInput(e.target.value)}
                  autoFocus
                  placeholder="0.00"
                  style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: TX, background: 'var(--track,#f7f7f9)', border: '1px solid var(--border,rgba(0,0,0,0.1))', borderRadius: 10, padding: '8px 12px' }}
                />
                <button type="button" disabled={saving || costInput.trim() === '' || !(Number(costInput) >= 0)} onClick={() => submitCost(Number(costInput))} style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: COLOR, border: 'none', borderRadius: 10, padding: '8px 14px', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                  Save
                </button>
                {vm.costSource === 'manual' && (
                  <button type="button" disabled={saving} onClick={() => submitCost(null)} title="Revert to automatic costing" style={{ fontSize: 13, fontWeight: 600, color: TD, background: 'var(--track,#f7f7f9)', border: '1px solid var(--border,rgba(0,0,0,0.1))', borderRadius: 10, padding: '8px 12px', cursor: 'pointer' }}>
                    Auto
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => setEditing(false)} style={{ fontSize: 13, fontWeight: 600, color: TD, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 4px' }}>
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

/** "11m" / "1h 4m" — charge duration label. */
function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
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
    <div style={{ display: 'flex', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none', paddingTop: 2 }}>
        <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexToRgba(COLOR, isDark ? 0.22 : 0.12) }}>
          {battery != null ? <BatteryGlyph pct={battery} color={COLOR} size={18} /> : <Icon d={ICON.battery} size={15} color={COLOR} />}
        </span>
        {connector && (
          <span style={{ flex: 1, marginTop: 5, marginBottom: -3, minHeight: 16, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingBottom: connector ? 16 : 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stamp || '—'}
        </span>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>
          {battery != null ? `${battery}%` : DASH}
        </span>
      </div>
    </div>
  )
}
