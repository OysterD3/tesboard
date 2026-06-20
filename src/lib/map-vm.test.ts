import { describe, expect, it } from 'vitest'
import { chargePoints, groupRoutes, type RouteSnap, type RouteWindow } from './map-vm'
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

const charge = (id: number, lat: number | null, lng: number | null): ChargeWithLocation =>
  ({ id, lat, lng } as ChargeWithLocation)

describe('chargePoints', () => {
  it('emits one point per located session (the map clusters them dynamically)', () => {
    const pts = chargePoints([charge(1, 3.1, 101.7), charge(2, 3.1, 101.7), charge(3, 3.2, 101.65)])
    expect(pts).toHaveLength(3)
    expect(pts[0]).toEqual({ lat: 3.1, lng: 101.7, id: '1' })
  })

  it('skips charges without coordinates', () => {
    const pts = chargePoints([charge(1, null, null), charge(2, 1, 2), charge(3, 3, null)])
    expect(pts).toHaveLength(1)
    expect(pts[0]).toEqual({ lat: 1, lng: 2, id: '2' })
  })
})
