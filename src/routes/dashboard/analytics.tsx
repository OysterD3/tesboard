import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON } from '../../components/dashboard/theme'
import {
  distUnit,
  effFromWhKm,
  effSuffix,
  fmtDist,
  fmtSpeed,
  fmtTemp,
  speedUnit,
  tempUnit,
  type Units,
} from '../../lib/units'
import { useDisplayTz } from '../../lib/use-hydrated'

export const Route = createFileRoute('/dashboard/analytics')({ component: AnalyticsPage })

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const MI_TO_KM = 1.609344
const round1 = (n: number) => Math.round(n * 10) / 10

/** Label a speed bucket (lower edge, mph) as a display-unit range, e.g. "30–40". */
function speedBinLabel(u: Units, lowerMph: number, binMph = 10): string {
  return `${fmtSpeed(u, lowerMph * MI_TO_KM)}–${fmtSpeed(u, (lowerMph + binMph) * MI_TO_KM)}`
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ${h % 24}h`
  const m = Math.floor((seconds % 3600) / 60)
  return h >= 1 ? `${h}h ${m}m` : `${m}m`
}

const STATE_COLORS: Record<string, string> = {
  online: '#34c759',
  asleep: '#8b5cf6',
  offline: '#86868b',
  driving: '#6366f1',
  charging: '#f59e0b',
}

function AnalyticsPage() {
  const { battery, efficiency, mileage, states, timeline } = dashApi.useLoaderData()
  const tz = useDisplayTz()
  const { units: u, accent } = useDash()

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ViewTitle>Analytics</ViewTitle>

      {/* ── Battery health (taps through to the dedicated screen) ────── */}
      {battery.degradationPct != null ? (
        <Link to="/dashboard/battery" search={(prev) => prev} style={{ textDecoration: 'none' }}>
        <Card radius={22} style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Battery health</span>
            <Icon d={ICON.chevron} size={18} color={TD} />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em', color: TX }}>
              {round1(100 - (battery.degradationPct ?? 0))}
            </span>
            <span style={{ fontSize: 17, fontWeight: 600, color: TD }}>% of best</span>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
            <Mini value={battery.currentKwh != null ? `${round1(battery.currentKwh)} kWh` : '—'} label="Current capacity" />
            <Mini value={battery.maxKwh != null ? `${round1(battery.maxKwh)} kWh` : '—'} label="Best observed" />
            <Mini
              value={
                battery.projectedRangeMi != null
                  ? `${fmtDist(u, battery.projectedRangeMi * MI_TO_KM)} ${distUnit(u)}`
                  : '—'
              }
              label="Projected range @100%"
            />
          </div>
          {battery.series.length >= 2 && (
            <SparkBars
              values={battery.series.map((p) => p.capacityKwh)}
              color={accent}
              label={`${battery.series.length} charge points`}
            />
          )}
        </Card>
        </Link>
      ) : (
        <EmptyCard
          title="No battery-health data yet"
          body="Degradation is derived from rated range + SOC at charge end × the per-vehicle efficiency factor. It appears after a few full-ish charges (or a TeslaMate import)."
        />
      )}

      {/* ── Charge cycles ───────────────────────────────────────────── */}
      {battery.totalChargeEnergyKwh != null && (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Charge cycles</span>
          {battery.chargeCycleCount != null ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em', color: TX }}>
                {round1(battery.chargeCycleCount)}
              </span>
              <span style={{ fontSize: 17, fontWeight: 600, color: TD }}>equivalent full cycles</span>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: 46, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.04em', color: TX }}>
                {Math.round(battery.totalChargeEnergyKwh).toLocaleString('en-US')}
              </span>
              <span style={{ fontSize: 17, fontWeight: 600, color: TD }}>kWh added</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
            <Mini
              value={`${Math.round(battery.totalChargeEnergyKwh).toLocaleString('en-US')} kWh`}
              label="Lifetime energy added"
            />
            <Mini
              value={battery.packKwh != null ? `${round1(battery.packKwh)} kWh` : 'Not set'}
              label="Pack capacity"
            />
          </div>
          {battery.chargeCycleCount == null && (
            <p style={{ fontSize: 11.5, fontWeight: 500, color: TD, margin: '12px 0 0', lineHeight: 1.4 }}>
              Set this vehicle’s pack capacity to see equivalent full cycles — one full pack’s worth
              of energy is one cycle.
            </p>
          )}
        </Card>
      )}

      {/* ── Efficiency vs temperature ───────────────────────────────── */}
      {efficiency.bins.length > 0 ? (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Efficiency vs outside temp</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '8px 0 14px' }}>
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>
              {efficiency.avgWhPerMi != null ? effFromWhKm(u, efficiency.avgWhPerMi / MI_TO_KM) : '—'}
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: TD }}>{effSuffix(u)} avg · {efficiency.sampleCount} drives</span>
          </div>
          <BinBars
            bins={efficiency.bins.map((b) => ({
              label: `${fmtTemp(u, b.tempC)}${tempUnit(u)}`,
              value: effFromWhKm(u, b.avgWhPerMi / MI_TO_KM),
              count: b.count,
            }))}
            color={accent}
          />
        </Card>
      ) : (
        <EmptyCard title="No efficiency-vs-temp data yet" body="Built from each drive's Wh/mi and its average outside temperature." />
      )}

      {/* ── Efficiency vs average speed ─────────────────────────────── */}
      {efficiency.speedBins.length > 0 ? (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>
            Efficiency vs avg speed ({speedUnit(u)})
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '8px 0 14px' }}>
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>
              {efficiency.speedAvgWhPerMi != null ? effFromWhKm(u, efficiency.speedAvgWhPerMi / MI_TO_KM) : '—'}
            </span>
            <span style={{ fontSize: 14, fontWeight: 600, color: TD }}>{effSuffix(u)} avg · {efficiency.speedSampleCount} drives</span>
          </div>
          <BinBars
            bins={efficiency.speedBins.map((b) => ({
              label: speedBinLabel(u, b.speedMph),
              value: effFromWhKm(u, b.avgWhPerMi / MI_TO_KM),
              count: b.count,
            }))}
            color={accent}
          />
        </Card>
      ) : (
        <EmptyCard title="No efficiency-vs-speed data yet" body="Built from each drive's Wh/mi and its average speed (distance ÷ moving time)." />
      )}

      {/* ── Mileage ─────────────────────────────────────────────────── */}
      {mileage.buckets.length > 0 ? (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Mileage by month</span>
          <div style={{ display: 'flex', gap: 24, margin: '10px 0 14px', flexWrap: 'wrap' }}>
            <Mini value={`${fmtDist(u, mileage.totalMi * MI_TO_KM).toLocaleString('en-US')} ${distUnit(u)}`} label="Total distance" />
            <Mini
              value={mileage.currentOdometerMi != null ? `${fmtDist(u, mileage.currentOdometerMi * MI_TO_KM).toLocaleString('en-US')} ${distUnit(u)}` : '—'}
              label="Odometer"
            />
          </div>
          <BinBars
            bins={mileage.buckets.slice(-12).map((b) => ({
              label: b.period,
              value: round1(fmtDist(u, b.distanceMi * MI_TO_KM)),
              count: null,
            }))}
            color="#6366f1"
          />
        </Card>
      ) : (
        <EmptyCard title="No mileage yet" body="Accumulates from recorded drives." />
      )}

      {/* ── Time in state ───────────────────────────────────────────── */}
      {states.timeInState.length > 0 && (
        <Card radius={22} style={{ padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Time by state · last 30 days</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 14 }}>
            {states.timeInState.map((s) => (
              <div key={s.state}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: TX, textTransform: 'capitalize' }}>{s.state}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{fmtDuration(s.seconds)} · {Math.round(s.pct)}%</span>
                </div>
                <div style={{ height: 8, borderRadius: 5, background: 'var(--track,#f0f0f3)', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(2, s.pct)}%`, height: '100%', background: STATE_COLORS[s.state] ?? accent }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Recent timeline ─────────────────────────────────────────── */}
      {timeline.length > 0 && (
        <Card radius={22} style={{ padding: '6px 20px 14px' }}>
          <div style={{ padding: '16px 0 4px' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Recent activity</span>
          </div>
          {timeline.slice(0, 20).map((e, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '11px 0',
                borderBottom: i < 19 ? '1px solid var(--border,rgba(0,0,0,0.06))' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATE_COLORS[e.kind] ?? accent, flex: 'none' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: TX, textTransform: 'capitalize' }}>{e.title}</span>
                {e.detail && <span style={{ fontSize: 12, fontWeight: 500, color: TD, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.detail}</span>}
              </div>
              <span style={{ fontSize: 11, fontWeight: 500, color: TD, flex: 'none' }}>
                {new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}
              </span>
            </div>
          ))}
        </Card>
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

/** Simple max-normalized horizontal bars (label · value). */
function BinBars({
  bins,
  color,
}: {
  bins: { label: string; value: number; count: number | null }[]
  color: string
}) {
  const max = Math.max(...bins.map((b) => b.value), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {bins.map((b) => (
        <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: TD, width: 64, flex: 'none', textAlign: 'right' }}>{b.label}</span>
          <div style={{ flex: 1, height: 18, borderRadius: 5, background: 'var(--track,#f0f0f3)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, (b.value / max) * 100)}%`, height: '100%', background: color, opacity: 0.85 }} />
          </div>
          <span style={{ fontSize: 12, fontWeight: 700, color: TX, width: 52, flex: 'none' }}>{b.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Tiny capacity-trend sparkline as normalized vertical bars. */
function SparkBars({ values, color, label }: { values: number[]; color: string; label: string }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }}>
        {values.slice(-40).map((v, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${20 + ((v - min) / span) * 80}%`,
              background: color,
              opacity: 0.7,
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 11, fontWeight: 500, color: TD, marginTop: 6, display: 'block' }}>{label}</span>
    </div>
  )
}
