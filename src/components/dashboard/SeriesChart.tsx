/**
 * A hand-rolled SVG line+area chart for a per-sample time series (battery,
 * speed, elevation, cabin/outside temperature on the drive-detail page). Plots
 * `points` ({x, y}) on a real x-scale (x = elapsed minutes) so irregular poll
 * cadence stays faithful, with a hover crosshair + viewBox-native tooltip
 * modeled on BatteryScatter. The caller owns unit conversion via the
 * `formatX`/`formatY` callbacks; this stays theme-agnostic (CSS vars + accent).
 */
import { useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { round } from './theme'

export interface SeriesPoint {
  x: number
  y: number
}

const TD = 'var(--td,#86868b)'

export function SeriesChart({
  points,
  color,
  formatX,
  formatY,
  unitX = '',
  unitY = '',
  height = 150,
}: {
  points: SeriesPoint[]
  color: string
  formatX: (x: number) => string
  formatY: (y: number) => string
  /** Unit suffix for the x value in the hover tooltip. */
  unitX?: string
  /** Unit suffix for the y value in the hover tooltip (e.g. "mph"). */
  unitY?: string
  height?: number
}) {
  const clip = useId().replace(/:/g, '')
  const gid = 'sArea-' + clip
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const W = 340
  const H = height
  const ML = 44
  const MR = 14
  const MT = 14
  const MB = 22
  const plotW = W - ML - MR
  const plotH = H - MT - MB

  const valid = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x)
  if (valid.length < 2) return null

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
  const yPad = (yMax - yMin) * 0.16 || Math.max(1, Math.abs(yMax) * 0.04)
  yMin -= yPad
  yMax += yPad
  if (yMin === yMax) {
    yMin -= 1
    yMax += 1
  }

  const sx = (x: number) => ML + ((x - xMin) / (xMax - xMin)) * plotW
  const sy = (y: number) => MT + (1 - (y - yMin) / (yMax - yMin)) * plotH

  const linePath = 'M' + valid.map((p) => `${round(sx(p.x), 1)},${round(sy(p.y), 1)}`).join(' L')
  const baseline = MT + plotH
  const areaPath = `${linePath} L${round(sx(xMax), 1)},${baseline} L${round(sx(xMin), 1)},${baseline} Z`
  const gridY = [yMax, (yMax + yMin) / 2, yMin]
  const showDots = valid.length <= 60

  // Pointer x → nearest sample by x (a line always yields a readout anywhere
  // along it). CTM maps client coords to viewBox units through the letterboxing.
  function pick(e: ReactPointerEvent<SVGSVGElement>) {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!ctm) return
    const loc = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < valid.length; i++) {
      const dx = sx(valid[i].x) - loc.x
      const d = dx * dx
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setActive(best)
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
      style={{ display: 'block', overflow: 'visible', touchAction: 'pan-y', cursor: 'crosshair' }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x={ML} y={MT} width={plotW} height={plotH} />
        </clipPath>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
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

      {/* x-axis ticks (min/max elapsed time) */}
      <text x={ML} y={H - 5} textAnchor="start" fontSize="10" fontWeight="600" fill={TD}>
        {formatX(xMin)}
      </text>
      <text x={W - MR} y={H - 5} textAnchor="end" fontSize="10" fontWeight="600" fill={TD}>
        {formatX(xMax)}
      </text>

      <g clipPath={`url(#${clip})`}>
        <path d={areaPath} fill={`url(#${gid})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {showDots &&
          valid.map((p, i) => (
            <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="2.4" fill={color} fillOpacity={ai === i ? 0 : 0.55} />
          ))}
      </g>

      {/* Hover readout: vertical guide + emphasised dot + viewBox-native tooltip. */}
      {ai != null && (() => {
        const p = valid[ai]
        const cx = sx(p.x)
        const cy = sy(p.y)
        const l1 = `${formatY(p.y)}${unitY ? ' ' + unitY : ''}`
        const l2 = `${formatX(p.x)}${unitX ? ' ' + unitX : ''}`
        const tw = Math.max(l1.length, l2.length) * 6.4 + 18
        const th = 31
        const bx = Math.max(ML, Math.min(W - MR - tw, cx - tw / 2))
        // Prefer above the point; flip below when it would clip the top. Clamp to
        // the viewBox either way so the box can't spill past the chart edges.
        const byPref = cy - th - 9 >= MT ? cy - th - 9 : cy + 9
        const by = Math.max(MT, Math.min(H - th - 2, byPref))
        return (
          <g pointerEvents="none">
            <line x1={cx} y1={MT} x2={cx} y2={baseline} stroke={color} strokeOpacity="0.5" strokeWidth="1" />
            <circle cx={cx} cy={cy} r="7" fill={color} fillOpacity="0.18" />
            <circle cx={cx} cy={cy} r="4" fill={color} />
            <rect x={bx} y={by} width={tw} height={th} rx="7" fill="var(--card,#fff)" stroke="var(--border,rgba(0,0,0,0.1))" />
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
