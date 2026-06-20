import { describe, expect, it } from 'vitest'
import { buildChargeMarkers, groupRoutes, type RouteSnap, type RouteWindow } from './map-vm'
import type { ChargeWithLocation } from '../functions/charging.functions'

const snap = (atMs: number, lat: number, lng: number): RouteSnap => ({ lat, lng, atMs })
const win = (startMs: number, endMs: number): RouteWindow => ({ startMs, endMs })

describe('groupRoutes', () => {
  it('builds one polyline per drive window', () => {
    const snaps = [snap(10, 1, 1), snap(20, 2, 2), snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(2)
    expect(routes[0]).toEqual([
      [1, 1],
      [2, 2],
    ])
    expect(routes[1]).toEqual([
      [3, 3],
      [4, 4],
    ])
  })

  it('drops parked fixes that fall between drives (no teleport lines)', () => {
    const snaps = [snap(10, 1, 1), snap(20, 2, 2), snap(70, 9, 9) /* parked gap */, snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(2)
    expect(routes.flat()).not.toContainEqual([9, 9])
  })

  it('skips windows with fewer than two fixes', () => {
    const snaps = [snap(10, 1, 1) /* lone fix */, snap(110, 3, 3), snap(120, 4, 4)]
    const windows = [win(0, 50), win(100, 150)]
    const routes = groupRoutes(snaps, windows)
    expect(routes).toHaveLength(1)
    expect(routes[0]).toEqual([
      [3, 3],
      [4, 4],
    ])
  })

  it('downsamples a long path to the cap, keeping first + last', () => {
    const snaps = Array.from({ length: 100 }, (_, i) => snap(i, i, i))
    const routes = groupRoutes(snaps, [win(0, 99)], { maxPerPath: 10 })
    expect(routes[0].length).toBeLessThanOrEqual(10)
    expect(routes[0][0]).toEqual([0, 0])
    expect(routes[0][routes[0].length - 1]).toEqual([99, 99])
  })

  it('returns nothing when there are no windows', () => {
    expect(groupRoutes([snap(10, 1, 1), snap(20, 2, 2)], [])).toEqual([])
  })
})

const charge = (lat: number | null, lng: number | null): ChargeWithLocation =>
  ({ lat, lng } as ChargeWithLocation)

describe('buildChargeMarkers', () => {
  it('clusters charges at the same ~111 m cell and counts them', () => {
    const markers = buildChargeMarkers([
      charge(3.1001, 101.7001),
      charge(3.1002, 101.7003), // same 3-dp cell → clustered
      charge(3.2, 101.65), // different cell
    ])
    expect(markers).toHaveLength(2)
    const home = markers.find((m) => m.count === 2)
    expect(home).toBeTruthy()
    expect(markers.find((m) => m.count === 1)).toBeTruthy()
  })

  it('skips charges without coordinates', () => {
    const markers = buildChargeMarkers([charge(null, null), charge(1, 2), charge(3, null)])
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ lat: 1, lng: 2, count: 1 })
  })
})
