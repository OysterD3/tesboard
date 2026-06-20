/**
 * Pure helpers for the lifetime Map views (drives + charging). Kept React-free /
 * server-free so they're unit-testable: the drives map groups raw GPS snapshots
 * into one polyline per drive, and the charging map collapses charge sessions into
 * location clusters with counts. The server fn / route feed these and the
 * LifetimeMap component renders the result.
 */
import { downsampleSeries } from './drive-detail-vm'
import type { ChargeWithLocation } from '../functions/charging.functions'

export type LatLng = [number, number]

export interface RouteSnap {
  lat: number
  lng: number
  /** Epoch ms of the snapshot (recorded_at). */
  atMs: number
}

export interface RouteWindow {
  /** Epoch ms of the drive's start / end. */
  startMs: number
  endMs: number
}

/** A charge location cluster: a point and how many sessions happened there. */
export interface ChargeMarker {
  lat: number
  lng: number
  count: number
}

/**
 * Assign each GPS snapshot to the drive whose [start, end] window contains it,
 * producing one ordered polyline per drive. Both inputs MUST be sorted ascending
 * by time (snaps by atMs, windows by startMs); drives are non-overlapping, so a
 * single forward sweep is enough. Snapshots that fall between drives (parked) are
 * dropped — they'd draw teleport lines across the map. Each path is downsampled to
 * `maxPerPath` points and paths are capped at `maxPaths`; paths with <2 points are
 * skipped (can't draw a line from one fix).
 */
export function groupRoutes(
  snaps: RouteSnap[],
  windows: RouteWindow[],
  opts?: { maxPerPath?: number; maxPaths?: number },
): LatLng[][] {
  const maxPerPath = opts?.maxPerPath ?? 60
  const maxPaths = opts?.maxPaths ?? 1000
  const routes: LatLng[][] = []
  let wi = 0
  let cur: LatLng[] = []
  for (const s of snaps) {
    // Leave any windows this snapshot is already past, flushing their points.
    while (wi < windows.length && s.atMs > windows[wi].endMs) {
      if (cur.length >= 2) routes.push(cur)
      cur = []
      wi++
    }
    if (wi >= windows.length) break
    if (s.atMs >= windows[wi].startMs) cur.push([s.lat, s.lng])
    // else: before this window (a parked gap between drives) → skip.
  }
  if (cur.length >= 2) routes.push(cur)
  return routes.slice(0, maxPaths).map((r) => downsampleSeries(r, maxPerPath))
}

/**
 * Collapse charge sessions into location clusters: round each lat/lng to a ~111 m
 * grid (3 dp) and count sessions per cell, so a home charged 40 times shows as one
 * marker labelled 40 rather than 40 stacked pins. Sessions without coordinates are
 * skipped. The cluster point is the first session's exact coordinate in the cell.
 */
export function buildChargeMarkers(sessions: ChargeWithLocation[]): ChargeMarker[] {
  const byCell = new Map<string, ChargeMarker>()
  for (const s of sessions) {
    if (s.lat == null || s.lng == null) continue
    const key = `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`
    const existing = byCell.get(key)
    if (existing) existing.count++
    else byCell.set(key, { lat: s.lat, lng: s.lng, count: 1 })
  }
  return [...byCell.values()]
}
