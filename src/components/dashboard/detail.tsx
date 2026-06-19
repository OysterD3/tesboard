/**
 * Shared building blocks for the Tessie-style detail pages (drive + charge):
 * a titled section card, a 2-up tile row, a divider, the circular-icon stat tile,
 * a series chart with an honest empty state, and a currency formatter. Kept here
 * so the drive- and charge-detail routes render an identical visual language.
 * Theme-agnostic (CSS vars + an accent color), like the other primitives.
 */
import type { ReactNode } from 'react'
import { Card, Icon } from './primitives'
import { SeriesChart, type SeriesPoint } from './SeriesChart'

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

/** Em dash for a missing value. */
export const DASH = '—'

/** "$1.84" for USD, "1.84 EUR" otherwise; "—" when there's nothing to show. */
export function fmtMoney(c: { amount: number; currency: string } | null): string {
  if (!c) return DASH
  const n = c.amount.toFixed(2)
  return c.currency === 'USD' ? `$${n}` : `${n} ${c.currency}`
}

/** A titled section block (header, then tiles and/or a chart). */
export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card radius={22} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>{title}</span>
      {children}
    </Card>
  )
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>{children}</div>
}

export function Divider() {
  return <div style={{ height: 1, background: 'var(--border,rgba(0,0,0,0.07))' }} />
}

/** Circular-icon stat tile: icon badge + label + value (+ optional unit). */
export function StatTile({
  icon,
  glyph,
  label,
  value,
  unit,
  accent,
  fill = false,
}: {
  icon?: string
  /** Custom badge content (e.g. a fill-by-percentage BatteryGlyph); overrides `icon`. */
  glyph?: ReactNode
  label: string
  value: string
  unit?: string
  accent: string
  fill?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <div
        style={{
          width: 42,
          height: 42,
          flex: 'none',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--track,#f0f0f3)',
        }}
      >
        {glyph ?? (icon ? <Icon d={icon} size={20} color={accent} fill={fill ? accent : 'none'} stroke={!fill} width={1.9} /> : null)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: TD, whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value}
          </span>
          {unit ? <span style={{ fontSize: 12, fontWeight: 600, color: TD, flex: 'none' }}>{unit}</span> : null}
        </div>
      </div>
    </div>
  )
}

/** A series chart, or an honest empty placeholder when there aren't ≥2 points. */
export function Chart({
  points,
  color,
  formatX,
  formatY,
  unitY,
  empty,
  baseline,
}: {
  points: SeriesPoint[]
  color: string
  formatX: (x: number) => string
  formatY: (y: number) => string
  unitY: string
  empty: string
  baseline?: number
}): ReactNode {
  if (points.length >= 2) {
    return <SeriesChart points={points} color={color} formatX={formatX} formatY={formatY} unitY={unitY} baseline={baseline} />
  }
  return (
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
  )
}
