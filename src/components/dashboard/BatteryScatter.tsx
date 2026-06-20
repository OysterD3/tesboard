/**
 * A hand-rolled SVG scatter for the battery-health view: each charge reading is
 * a translucent dot, with a least-squares trend line through them (the Tessie
 * "fleet average" slot, but it's *your* trend — we have no fleet data). Themed
 * through the dashboard CSS vars; the accent is passed in. X/Y are plotted in
 * raw units and the `formatX`/`formatY` callbacks render the axis ticks, so the
 * caller owns unit conversion (miles→km, etc.).
 */
import { useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { linearRegression } from '../../lib/analytics-vm'

export interface ScatterPoint {
  x: number
  y: number
}

const TD = 'var(--td,#86868b)'

export function BatteryScatter({
  points,
  color,
  formatX,
  formatY,
  unitX = '',
  unitY = '',
  height = 172,
}: {
  points: ScatterPoint[]
  color: string
  formatX: (x: number) => string
  formatY: (y: number) => string
  /** Unit suffix for the x value in the hover tooltip (e.g. "mi"). */
  unitX?: string
  /** Unit suffix for the y value in the hover tooltip (e.g. "kWh"). */
  unitY?: string
  height?: number
}) {
  const clip = useId().replace(/:/g, '')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const W = 340
  const H = height
  const ML = 46
  const MR = 12
  const MT = 12
  const MB = 22
  const plotW = W - ML - MR
  const plotH = H - MT - MB

  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  if (valid.length === 0) return null

  const xs = valid.map((p) => p.x)
  const ys = valid.map((p) => p.y)
  let xMin = Math.min(...xs)
  let xMax = Math.max(...xs)
  let yMin = Math.min(...ys)
  let yMax = Math.max(...ys)
  if (xMin === xMax) {
    xMin -= 1
    xMax += 1
  }
  const yPad = (yMax - yMin) * 0.18 || Math.max(1, Math.abs(yMax) * 0.02)
  yMin -= yPad
  yMax += yPad
  if (yMin === yMax) {
    yMin -= 1
    yMax += 1
  }

  const sx = (x: number) => ML + ((x - xMin) / (xMax - xMin)) * plotW
  const sy = (y: number) => MT + (1 - (y - yMin) / (yMax - yMin)) * plotH

  const trend = linearRegression(valid)
  const gridY = [yMax, (yMax + yMin) / 2, yMin]

  // Map the pointer to viewBox units via the live CTM (robust to the `meet`
  // letterboxing) and pick the nearest reading within a generous hit radius.
  function pick(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!ctm) return
    const loc = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < valid.length; i++) {
      const dx = sx(valid[i].x) - loc.x
      const dy = sy(valid[i].y) - loc.y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setActive(bestD <= 26 * 26 ? best : null)
  }
  const clear = () => setActive(null)

  const ai = active != null && active < valid.length ? active : null

  return (
    <svg
      ref={svgRef}
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={pick}
      onPointerMove={pick}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
      className="block overflow-visible touch-pan-y"
    >
      <defs>
        <clipPath id={clip}>
          <rect x={ML} y={MT} width={plotW} height={plotH} />
        </clipPath>
      </defs>

      {/* horizontal gridlines + y-axis ticks */}
      {gridY.map((gy, i) => (
        <g key={i}>
          <line
            x1={ML}
            y1={sy(gy)}
            x2={W - MR}
            y2={sy(gy)}
            stroke={TD}
            strokeOpacity="0.16"
            strokeDasharray="2 5"
          />
          <text x={ML - 7} y={sy(gy) + 3.4} textAnchor="end" fontSize="10" fontWeight="600" fill={TD}>
            {formatY(gy)}
          </text>
        </g>
      ))}

      {/* x-axis ticks */}
      <text x={ML} y={H - 5} textAnchor="start" fontSize="10" fontWeight="600" fill={TD}>
        {formatX(xMin)}
      </text>
      <text x={W - MR} y={H - 5} textAnchor="end" fontSize="10" fontWeight="600" fill={TD}>
        {formatX(xMax)}
      </text>

      {/* The trend line is clipped to the plot rect so a steep slope can't draw
          over the axis labels. The dots don't need clipping — the y-padding keeps
          every reading strictly inside the plot vertically — and leaving them
          unclipped means the leftmost/rightmost points (which always sit on the
          x-extremes) render as full circles instead of sheared half-dots. */}
      {trend && (
        <g clipPath={`url(#${clip})`}>
          <line
            x1={sx(xMin)}
            y1={sy(trend.slope * xMin + trend.intercept)}
            x2={sx(xMax)}
            y2={sy(trend.slope * xMax + trend.intercept)}
            stroke={color}
            strokeOpacity="0.9"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </g>
      )}
      {valid.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3.4" fill={color} fillOpacity={ai === i ? 0 : 0.4} />
      ))}

      {/* Hover readout: emphasised dot + a viewBox-native tooltip (drawn inside
          the svg so it stays aligned regardless of how the chart is scaled). */}
      {ai != null && (() => {
        const p = valid[ai]
        const cx = sx(p.x)
        const cy = sy(p.y)
        const l1 = `${formatY(p.y)}${unitY ? ' ' + unitY : ''}`
        const l2 = `${formatX(p.x)}${unitX ? ' ' + unitX : ''}`
        // Manrope is proportional; over-estimate width so wide glyphs never
        // overflow the box (a slightly roomy tooltip is harmless).
        const tw = Math.max(l1.length, l2.length) * 6.4 + 18
        const th = 31
        // Keep the box inside the plot rect so it never paints over the y-axis
        // tick labels (which sit left of ML).
        const bx = Math.max(ML, Math.min(W - MR - tw, cx - tw / 2))
        const by = cy - th - 9 >= MT ? cy - th - 9 : cy + 9
        return (
          <g pointerEvents="none">
            <circle cx={cx} cy={cy} r="7" fill={color} fillOpacity="0.18" />
            <circle cx={cx} cy={cy} r="4" fill={color} />
            <rect
              x={bx}
              y={by}
              width={tw}
              height={th}
              rx="7"
              fill="var(--card,#fff)"
              stroke="var(--border,rgba(0,0,0,0.1))"
            />
            <text x={bx + 8} y={by + 13} fontSize="10.5" fontWeight="700" fill="var(--tx,#1d1d1f)">
              {l1}
            </text>
            <text x={bx + 8} y={by + 25} fontSize="9.5" fontWeight="600" fill={TD}>
              {l2}
            </text>
          </g>
        )
      })()}
    </svg>
  )
}
