/**
 * A hand-rolled SVG scatter for the battery-health view: each charge reading is
 * a translucent dot, with a least-squares trend line through them (the Tessie
 * "fleet average" slot, but it's *your* trend — we have no fleet data). Themed
 * through the dashboard CSS vars; the accent is passed in. X/Y are plotted in
 * raw units and the `formatX`/`formatY` callbacks render the axis ticks, so the
 * caller owns unit conversion (miles→km, etc.).
 */
import { useId } from 'react'
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
  height = 172,
}: {
  points: ScatterPoint[]
  color: string
  formatX: (x: number) => string
  formatY: (y: number) => string
  height?: number
}) {
  const clip = useId().replace(/:/g, '')
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

  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', overflow: 'visible' }}
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
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3.4" fill={color} fillOpacity="0.4" />
      ))}
    </svg>
  )
}
