/**
 * Shared visual primitives for the EV dashboard, ported from the Claude Design
 * handoff. Everything is themed through the CSS variables set on the dashboard
 * root (see theme.ts / DashboardProvider), so these stay theme-agnostic.
 */
import type { CSSProperties, ReactNode } from 'react'
import { hexToRgba, round } from './theme'
import { cn } from '../../lib/utils'

const CARD_BASE: CSSProperties = {
  background: 'var(--card,#fff)',
  border: '1px solid var(--border,rgba(0,0,0,0.07))',
  boxShadow: 'var(--shadow)',
}

export function Card({
  children,
  radius = 20,
  style,
  className,
}: {
  children: ReactNode
  radius?: number
  style?: CSSProperties
  className?: string
}) {
  return (
    <div className={cn(className)} style={{ ...CARD_BASE, borderRadius: radius, ...style }}>
      {children}
    </div>
  )
}

/** A 24×24 stroked icon (multi-subpath `d`). */
export function Icon({
  d,
  size = 20,
  color = 'currentColor',
  fill = 'none',
  stroke = true,
  width = 2,
}: {
  d: string
  size?: number
  color?: string
  fill?: string
  stroke?: boolean
  width?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke ? color : 'none'}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

/** Honest empty-state card shown when there's no live data for a view/panel. */
export function EmptyCard({ title, body }: { title: string; body?: string }) {
  return (
    <Card radius={20} style={{ padding: '28px 22px', textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tx,#1d1d1f)' }}>{title}</div>
      {body && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--td,#86868b)', marginTop: 6, lineHeight: 1.5 }}>{body}</div>}
    </Card>
  )
}

/** Section title used at the top of Drives / Charging / Insights / Settings. */
export function ViewTitle({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        color: 'var(--tx,#1d1d1f)',
      }}
    >
      {children}
    </span>
  )
}

/** iOS-style segmented control. */
export interface SegOption<T extends string> {
  label: string
  value: T
}
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accent,
  isDark,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  accent: string
  isDark: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: 2,
        borderRadius: 11,
        background: 'var(--track,#f0f0f3)',
      }}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: 'none',
              cursor: 'pointer',
              borderRadius: 9,
              padding: '7px 13px',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              minWidth: 46,
              textAlign: 'center',
              color: active ? accent : 'var(--td,#86868b)',
              background: active ? 'var(--seg-active,#fff)' : 'transparent',
              boxShadow: active
                ? isDark
                  ? 'none'
                  : '0 1px 3px rgba(0,0,0,0.12), 0 1px 1px rgba(0,0,0,0.04)'
                : 'none',
              transition: 'color .15s ease',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** The battery state-of-charge ring on Overview. */
export function BatteryRing({
  soc,
  accent,
}: {
  soc: number | null
  accent: string
}) {
  const C = 2 * Math.PI * 90
  const dash = ((soc ?? 0) / 100) * C
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        position: 'relative',
        margin: '14px 0 6px',
      }}
    >
      <svg width="200" height="200" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="90" fill="none" stroke="var(--ring-track,#ececef)" strokeWidth="9" />
        <circle
          cx="100"
          cy="100"
          r="90"
          fill="none"
          stroke={accent}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${round(dash, 1)} ${round(C - dash, 1)}`}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start' }}>
          <span
            style={{
              fontSize: 60,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-0.04em',
              color: 'var(--tx,#1d1d1f)',
            }}
          >
            {soc ?? '—'}
          </span>
          <span
            style={{ fontSize: 24, fontWeight: 600, color: 'var(--td,#86868b)', marginTop: 5 }}
          >
            %
          </span>
        </div>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--td,#86868b)' }}>
          State of charge
        </span>
      </div>
    </div>
  )
}

/** Build the line + area SVG paths for a kW-vs-time charge curve. */
export function buildChart(curve: number[], axisMax: number) {
  const w = 280
  const h = 110
  const n = curve.length
  const pts = curve.map((kw, i) => [
    round((i / (n - 1)) * w, 1),
    round(h - (kw / axisMax) * h, 1),
  ])
  const line = 'M' + pts.map((p) => p[0] + ',' + p[1]).join(' L')
  const area = line + ' L' + w + ',' + h + ' L0,' + h + ' Z'
  return { line, area }
}

/** The charge-curve chart with a taper marker + axis labels. */
export function ChargeCurve({
  curve,
  axisMax,
  color,
  socRange,
  taperFrac,
}: {
  curve: number[]
  axisMax: number
  color: string
  socRange: string
  /** Fractional position (0–1) of the taper onset, or null to hide the marker (flat AC). */
  taperFrac?: number | null
}) {
  const { line, area } = buildChart(curve, axisMax)
  const hasTaper = taperFrac != null
  const frac = hasTaper ? taperFrac : 0
  const taperX = round(frac * 280, 1)
  const taperLeft = `calc(14px + (100% - 28px) * ${round(frac, 4)})`
  return (
    <div
      style={{
        position: 'relative',
        height: 128,
        borderRadius: 14,
        border: '1px solid var(--border,rgba(0,0,0,0.07))',
        background: 'var(--track,#f7f7f9)',
        padding: '14px 14px 6px',
      }}
    >
      <svg width="100%" height="100%" viewBox="0 0 280 110" preserveAspectRatio="none">
        <defs>
          <linearGradient id="cArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="36" x2="280" y2="36" stroke="var(--td,#86868b)" strokeOpacity="0.16" strokeDasharray="2 5" />
        <line x1="0" y1="73" x2="280" y2="73" stroke="var(--td,#86868b)" strokeOpacity="0.16" strokeDasharray="2 5" />
        {hasTaper && <line x1={taperX} y1="0" x2={taperX} y2="110" stroke={color} strokeOpacity="0.45" strokeWidth="1" strokeDasharray="3 3" />}
        <path d={area} fill="url(#cArea)" style={{ animation: 'drawArea 1s ease' }} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ strokeDasharray: 600, strokeDashoffset: 600, animation: 'drawRoute 1.4s .1s ease forwards' }}
        />
      </svg>
      {hasTaper && (
        <span
          style={{
            position: 'absolute',
            top: 6,
            left: taperLeft,
            transform: 'translateX(-50%)',
            fontSize: 9,
            fontWeight: 600,
            color,
            whiteSpace: 'nowrap',
          }}
        >
          taper
        </span>
      )}
      <span style={{ position: 'absolute', top: 8, right: 12, fontSize: 10, fontWeight: 600, color: 'var(--td,#86868b)' }}>
        {axisMax} kW
      </span>
      <span style={{ position: 'absolute', bottom: 5, left: 14, fontSize: 10, fontWeight: 600, color: 'var(--td,#86868b)' }}>
        {socRange}
      </span>
    </div>
  )
}

/** A selectable list row (drives + charging history share this shape). */
export function ListRow({
  active,
  color,
  isDark,
  onClick,
  left,
  right,
}: {
  active: boolean
  color: string
  isDark: boolean
  onClick: () => void
  left: ReactNode
  right: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border:
          '1px solid ' +
          (active ? hexToRgba(color, isDark ? 0.55 : 0.4) : 'var(--border,rgba(0,0,0,0.07))'),
        cursor: 'pointer',
        width: '100%',
        background: active
          ? hexToRgba(color, isDark ? 0.14 : 0.07)
          : 'var(--card,#fff)',
        borderRadius: 16,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        transition: 'background .2s ease, border-color .2s ease',
      }}
    >
      {left}
      {right}
    </button>
  )
}

/** The rounded icon chip used inside list rows. */
export function RowDot({
  active,
  color,
  isDark,
  children,
}: {
  active: boolean
  color: string
  isDark: boolean
  children: ReactNode
}) {
  return (
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 11,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active
          ? hexToRgba(color, isDark ? 0.22 : 0.12)
          : 'var(--track,#f0f0f3)',
      }}
    >
      {children}
    </div>
  )
}
