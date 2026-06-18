import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Card, EmptyCard, Icon } from '../../components/dashboard/primitives'
import { BatteryScatter, type ScatterPoint } from '../../components/dashboard/BatteryScatter'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, hexToRgba } from '../../components/dashboard/theme'
import { distUnit, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/battery')({ component: BatteryHealthPage })

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const MI_TO_KM = 1.609344
const BACK = 'M15 18l-6-6 6-6'
const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

function BatteryHealthPage() {
  const { battery } = dashApi.useLoaderData()
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
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0 2px' }}>
        <Link
          to="/dashboard/analytics"
          search={(prev) => prev}
          aria-label="Back to analytics"
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
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>
          Battery health
        </span>
      </div>

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
}) {
  return (
    <Card radius={22} style={{ padding: 20 }}>
      <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{title}</span>
      <p style={{ fontSize: 12.5, fontWeight: 500, color: TD, margin: '6px 0 0', lineHeight: 1.45 }}>{blurb}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '16px 0 14px' }}>
        <div
          style={{
            width: 46,
            height: 46,
            flex: 'none',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba(accent, isDark ? 0.22 : 0.12),
          }}
        >
          <Icon d={icon} size={22} color={accent} fill={icon === ICON.battery ? accent : 'none'} stroke={icon !== ICON.battery} width={1.9} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', color: TD }}>TOTAL</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.03em', color: TX }}>{total}</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: TD }}>{unit}</span>
          </div>
          {sub && <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{sub}</span>}
        </div>
      </div>

      {points.length >= 2 ? (
        <>
          <BatteryScatter points={points} color={accent} formatX={formatX} formatY={formatY} />
          <Legend accent={accent} count={points.length} />
        </>
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
          <span style={{ fontSize: 11, fontWeight: 500, color: TD }}>
            Collecting readings — a couple more charges and the trend appears.
          </span>
        </div>
      )}
    </Card>
  )
}

function Legend({ accent, count }: { accent: string; count: number }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, opacity: 0.45, flex: 'none' }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: TD }}>Reading</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 14, height: 2, borderRadius: 2, background: accent, flex: 'none' }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: TD }}>Trend</span>
      </span>
      <span style={{ fontSize: 11, fontWeight: 500, color: TD, marginLeft: 'auto' }}>{count} charge points</span>
    </div>
  )
}
