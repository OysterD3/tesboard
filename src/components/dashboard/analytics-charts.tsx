/**
 * Analytics-page chart primitives: max-normalized horizontal BinBars (temp /
 * speed / mileage) and a tiny capacity-trend SparkBars sparkline. Bar geometry
 * (computed widths/heights) and the per-instance accent `color` stay inline; the
 * static chrome is Tailwind via the @theme-inline bridge.
 */
import { useState } from 'react'
import { ChartTooltip, HoverBars } from './primitives'
import { fmtDay } from '../../lib/units'

/** Simple max-normalized horizontal bars (label · value); hover/tap shows the
 *  per-bin sample count when there is one. */
export function BinBars({
  bins,
  color,
}: {
  bins: { label: string; value: number; count: number | null }[]
  color: string
}) {
  const max = Math.max(...bins.map((b) => b.value), 1)
  const [active, setActive] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-[9px]">
      {bins.map((b, i) => (
        <div
          key={b.label}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse' && b.count != null) setActive(i) }}
          onPointerDown={() => { if (b.count != null) setActive(i) }}
          onPointerUp={() => setActive(null)}
          onPointerCancel={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="relative flex items-center gap-2.5"
          style={{ cursor: b.count != null ? 'pointer' : 'default' }}
        >
          <span className="w-16 flex-none text-right text-[11px] font-semibold text-muted-foreground">{b.label}</span>
          <div className="h-[18px] flex-1 overflow-hidden rounded-[5px] bg-secondary">
            <div className="h-full" style={{ width: `${Math.max(3, (b.value / max) * 100)}%`, background: color, opacity: 0.85 }} />
          </div>
          <span className="w-[52px] flex-none text-xs font-bold text-foreground">{b.value}</span>
          {active === i && b.count != null && (
            <ChartTooltip style={{ left: '50%', bottom: 'calc(100% + 5px)', transform: 'translateX(-50%)', maxWidth: '72vw' }}>
              {b.count} {b.count === 1 ? 'sample' : 'samples'}
            </ChartTooltip>
          )}
        </div>
      ))}
    </div>
  )
}

/** Tiny capacity-trend sparkline as normalized vertical bars, hover/tap to read. */
export function SparkBars({
  points,
  color,
  label,
  fmt,
}: {
  points: { date: string; value: number }[]
  color: string
  label: string
  fmt: (v: number) => string
}) {
  const shown = points.slice(-40)
  const values = shown.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return (
    <div className="mt-4">
      <HoverBars
        height={48}
        gap={2}
        color={color}
        opacity={0.7}
        bars={shown.map((p) => ({
          heightPct: 20 + ((p.value - min) / span) * 80,
          tip: (
            <>
              <span style={{ color }}>{fmt(p.value)}</span>
              <span className="font-medium text-muted-foreground"> · {fmtDay(p.date)}</span>
            </>
          ),
        }))}
      />
      <span className="mt-1.5 block text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  )
}
