import { Link, createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { analyticsQuery } from '../../lib/queries'
import { BigStat, Card, EmptyCard, Icon, SectionLabel, ViewTitle } from '../../components/dashboard/primitives'
import { BinBars, SparkBars } from '../../components/dashboard/analytics-charts'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, STATE_COLORS } from '../../components/dashboard/theme'
import { round1, fmtDurSec } from '../../lib/format'
import { speedBinLabel } from '../../lib/analytics-format'
import {
  distUnit,
  effFromWhKm,
  effSuffix,
  fmtDist,
  fmtTemp,
  speedUnit,
  tempUnit,
} from '../../lib/units'
import { cn } from '../../lib/utils'
import { useDisplayTz } from '../../lib/use-hydrated'

export const Route = createFileRoute('/dashboard/analytics')({
  // Loaded lazily here (not in the every-route parent loader) to keep SSR CPU low.
  loaderDeps: ({ search }) => ({ vin: (search as { vin?: string }).vin }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(analyticsQuery(deps.vin)),
  component: AnalyticsPage,
})

const MI_TO_KM = 1.609344

function AnalyticsPage() {
  const { battery, efficiency, mileage, states, timeline } = useSuspenseQuery(
    analyticsQuery(Route.useLoaderDeps().vin),
  ).data
  const tz = useDisplayTz()
  const { units: u, accent } = useDash()

  return (
    <div className="evd-view flex flex-col gap-3.5">
      <ViewTitle>Analytics</ViewTitle>

      {/* ── Battery health (taps through to the dedicated screen) ────── */}
      {battery.degradationPct != null ? (
        <Link to="/dashboard/battery" search={(prev) => prev} className="no-underline">
        <Card radius={22} className="p-5">
          <div className="flex items-center justify-between">
            <SectionLabel>Battery health</SectionLabel>
            <Icon d={ICON.chevron} size={18} color="var(--td,#86868b)" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[46px] font-bold leading-none tracking-[-0.04em] text-foreground">
              {round1(100 - (battery.degradationPct ?? 0))}
            </span>
            <span className="text-[17px] font-semibold text-muted-foreground">% of best</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-6">
            <BigStat value={battery.currentKwh != null ? `${round1(battery.currentKwh)} kWh` : '—'} label="Current capacity" />
            <BigStat value={battery.maxKwh != null ? `${round1(battery.maxKwh)} kWh` : '—'} label="Best observed" />
            <BigStat
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
              points={battery.series.map((p) => ({ date: p.date, value: p.capacityKwh }))}
              color={accent}
              label={`${battery.series.length} charge points`}
              fmt={(v) => `${round1(v)} kWh`}
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
        <Card radius={22} className="p-5">
          <SectionLabel>Charge cycles</SectionLabel>
          {battery.chargeCycleCount != null ? (
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[46px] font-bold leading-none tracking-[-0.04em] text-foreground">
                {round1(battery.chargeCycleCount)}
              </span>
              <span className="text-[17px] font-semibold text-muted-foreground">equivalent full cycles</span>
            </div>
          ) : (
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-[46px] font-bold leading-none tracking-[-0.04em] text-foreground">
                {Math.round(battery.totalChargeEnergyKwh).toLocaleString('en-US')}
              </span>
              <span className="text-[17px] font-semibold text-muted-foreground">kWh added</span>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-6">
            <BigStat
              value={`${Math.round(battery.totalChargeEnergyKwh).toLocaleString('en-US')} kWh`}
              label="Lifetime energy added"
            />
            <BigStat
              value={battery.packKwh != null ? `${round1(battery.packKwh)} kWh` : 'Not set'}
              label="Pack capacity"
            />
          </div>
          {battery.chargeCycleCount == null && (
            <p className="mt-3 text-[11.5px] font-medium leading-[1.4] text-muted-foreground">
              Set this vehicle’s pack capacity to see equivalent full cycles — one full pack’s worth
              of energy is one cycle.
            </p>
          )}
        </Card>
      )}

      {/* ── Efficiency vs temperature ───────────────────────────────── */}
      {efficiency.bins.length > 0 ? (
        <Card radius={22} className="p-5">
          <SectionLabel>Efficiency vs outside temp</SectionLabel>
          <div className="mb-3.5 mt-2 flex items-baseline gap-1.5">
            <span className="text-[30px] font-bold tracking-[-0.02em] text-foreground">
              {efficiency.avgWhPerMi != null ? effFromWhKm(u, efficiency.avgWhPerMi / MI_TO_KM) : '—'}
            </span>
            <span className="text-sm font-semibold text-muted-foreground">{effSuffix(u)} avg · {efficiency.sampleCount} drives</span>
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
        <Card radius={22} className="p-5">
          <SectionLabel>Efficiency vs avg speed ({speedUnit(u)})</SectionLabel>
          <div className="mb-3.5 mt-2 flex items-baseline gap-1.5">
            <span className="text-[30px] font-bold tracking-[-0.02em] text-foreground">
              {efficiency.speedAvgWhPerMi != null ? effFromWhKm(u, efficiency.speedAvgWhPerMi / MI_TO_KM) : '—'}
            </span>
            <span className="text-sm font-semibold text-muted-foreground">{effSuffix(u)} avg · {efficiency.speedSampleCount} drives</span>
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
        <Card radius={22} className="p-5">
          <SectionLabel>Mileage by month</SectionLabel>
          <div className="mb-3.5 mt-2.5 flex flex-wrap gap-6">
            <BigStat value={`${fmtDist(u, mileage.totalMi * MI_TO_KM).toLocaleString('en-US')} ${distUnit(u)}`} label="Total distance" />
            <BigStat
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
        <Card radius={22} className="p-5">
          <SectionLabel>Time by state · last 30 days</SectionLabel>
          <div className="mt-3.5 flex flex-col gap-[11px]">
            {states.timeInState.map((s) => (
              <div key={s.state}>
                <div className="mb-[5px] flex justify-between">
                  <span className="text-[13px] font-semibold capitalize text-foreground">{s.state}</span>
                  <span className="text-xs font-medium text-muted-foreground">{fmtDurSec(s.seconds)} · {Math.round(s.pct)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-[5px] bg-secondary">
                  <div className="h-full" style={{ width: `${Math.max(2, s.pct)}%`, background: STATE_COLORS[s.state] ?? accent }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Recent timeline ─────────────────────────────────────────── */}
      {timeline.length > 0 && (
        <Card radius={22} className="px-5 pb-3.5 pt-1.5">
          <div className="pb-1 pt-4">
            <SectionLabel>Recent activity</SectionLabel>
          </div>
          {timeline.slice(0, 20).map((e, i) => (
            <div
              key={i}
              className={cn('flex items-center justify-between py-[11px]', i < 19 && 'border-b border-border')}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: STATE_COLORS[e.kind] ?? accent }} />
                <span className="text-sm font-semibold capitalize text-foreground">{e.title}</span>
                {e.detail && <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium text-muted-foreground">{e.detail}</span>}
              </div>
              <span className="flex-none text-[11px] font-medium text-muted-foreground">
                {new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
