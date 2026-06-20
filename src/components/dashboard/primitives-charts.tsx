/**
 * Chart primitives for the EV dashboard: the floating value tooltip, the
 * hover/tap bar strip, and the battery ring/glyph. Static surface + layout map
 * to Tailwind bridge classes; computed geometry (bar heights, tooltip left/top)
 * and SVG presentation attributes stay inline.
 */
import { useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { round } from './theme'

/**
 * A floating value label for charts. Position it via `style` (left/top/bottom).
 * The surface (bg-card/border/shadow/typography) is in the className; only the
 * computed position is passed inline.
 */
export function ChartTooltip({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      className="absolute z-[5] pointer-events-none whitespace-nowrap rounded-[9px] border border-border bg-card px-[9px] py-[5px] text-[11px] font-semibold leading-[1.4] text-foreground shadow-[var(--shadow,0_6px_18px_rgba(0,0,0,0.16))]"
      style={style}
    >
      {children}
    </div>
  )
}

export interface HoverBar {
  /** Fill height as a percentage of the track (0–100). */
  heightPct: number
  /** Tooltip content revealed on hover (desktop) or tap/scrub (touch). */
  tip: ReactNode
}

/**
 * Evenly-spaced vertical bars with a shared hover/tap tooltip. The active bar is
 * derived from the pointer's x over the track (no per-bar listeners), so it
 * works for mouse hover *and* touch: tap or scrub on touch pins the value until
 * the next interaction; a mouse hides it on leave. The caller computes each
 * bar's height + tooltip content (it owns units/dates); this owns the gesture.
 */
export function HoverBars({
  bars,
  color,
  opacity = 0.6,
  height = 40,
  gap = 3,
  radius = 2,
}: {
  bars: HoverBar[]
  color: string
  opacity?: number
  height?: number
  gap?: number
  radius?: number
}) {
  const [active, setActive] = useState<number | null>(null)
  const n = bars.length

  function pick(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    const frac = (e.clientX - rect.left) / rect.width
    setActive(Math.min(n - 1, Math.max(0, Math.floor(frac * n))))
  }
  const clear = () => setActive(null)

  const a = active != null && active < n ? active : null
  const leftPct = a != null ? Math.min(94, Math.max(6, ((a + 0.5) / n) * 100)) : 0

  return (
    <div className="relative">
      {a != null && (
        <ChartTooltip style={{ left: `${leftPct}%`, bottom: height + 8, transform: 'translateX(-50%)', maxWidth: '72vw' }}>
          {bars[a].tip}
        </ChartTooltip>
      )}
      <div
        onPointerDown={pick}
        onPointerMove={pick}
        onPointerUp={clear}
        onPointerCancel={clear}
        onPointerLeave={clear}
        className="flex items-end touch-pan-y cursor-pointer"
        style={{ gap, height }}
      >
        {bars.map((b, i) => (
          <div
            key={i}
            className="flex-1 transition-opacity duration-[120ms]"
            style={{
              height: `${Math.max(0, Math.min(100, b.heightPct))}%`,
              background: color,
              opacity: i === a ? Math.min(1, opacity + 0.4) : opacity,
              borderRadius: radius,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/** The battery state-of-charge ring on Overview. */
export function BatteryRing({ soc, accent }: { soc: number | null; accent: string }) {
  const C = 2 * Math.PI * 90
  const dash = ((soc ?? 0) / 100) * C
  return (
    <div className="relative flex justify-center mt-[14px] mb-1.5">
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
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-[3px]">
        <div className="flex items-start">
          <span className="text-[60px] font-bold leading-none tracking-[-0.04em] text-foreground">{soc ?? '—'}</span>
          <span className="mt-[5px] text-2xl font-semibold text-muted-foreground">%</span>
        </div>
        <span className="text-[13px] font-medium text-muted-foreground">State of charge</span>
      </div>
    </div>
  )
}

/**
 * A horizontal battery glyph whose inner fill tracks the state-of-charge
 * percentage (0–100). Pure SVG (SSR-safe); `color` drives both the outline and
 * the fill so it inherits the surrounding accent.
 */
export function BatteryGlyph({ pct, color, size = 22 }: { pct: number; color: string; size?: number }) {
  const p = Math.max(0, Math.min(100, pct))
  const x = 2.5
  const y = 7
  const w = 16
  const h = 10
  const pad = 2
  const innerW = w - pad * 2
  const fillW = p > 0 ? Math.max(1, (innerW * p) / 100) : 0
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x={x} y={y} width={w} height={h} rx="2.4" stroke={color} strokeWidth="1.7" />
      <rect x={x + w + 0.8} y={y + h / 2 - 2.2} width="1.8" height="4.4" rx="0.9" fill={color} />
      {fillW > 0 && <rect x={x + pad} y={y + pad} width={fillW} height={h - pad * 2} rx="1.1" fill={color} />}
    </svg>
  )
}
