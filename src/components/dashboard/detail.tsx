/**
 * Shared building blocks for the Tessie-style detail pages (drive + charge):
 * a titled section card, a 2-up tile row, a divider, the circular-icon stat tile,
 * a series chart with an honest empty state, and a currency formatter. Kept here
 * so the drive- and charge-detail routes render an identical visual language.
 * Theme-agnostic (CSS vars + an accent color), like the other primitives.
 */
import type { ReactNode } from 'react'
import { Card, Icon, IconChip } from './primitives'
import { SeriesChart, type SeriesPoint } from './SeriesChart'

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
    <Card radius={22} className="flex flex-col gap-4 p-[18px]">
      <span className="text-[18px] font-bold tracking-[-0.02em] text-foreground">{title}</span>
      {children}
    </Card>
  )
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4">{children}</div>
}

export function Divider() {
  return <div className="h-px bg-border" />
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
    <div className="flex min-w-0 items-center gap-3">
      <IconChip size={42} color={accent}>
        {glyph ?? (icon ? <Icon d={icon} size={20} color={accent} fill={fill ? accent : 'none'} stroke={!fill} width={1.9} /> : null)}
      </IconChip>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </span>
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-[18px] font-bold tracking-[-0.02em] text-foreground">
            {value}
          </span>
          {unit ? <span className="flex-none text-xs font-semibold text-muted-foreground">{unit}</span> : null}
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
    <div className="flex h-24 items-center justify-center rounded-[14px] border border-border bg-secondary p-4 text-center">
      <span className="text-[11px] font-medium text-muted-foreground">{empty}</span>
    </div>
  )
}
