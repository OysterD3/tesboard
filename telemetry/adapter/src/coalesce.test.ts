import { describe, expect, it } from 'vitest'
import {
  applyMessage,
  buildSnapshot,
  getVinState,
  isActive,
  markFlushed,
  shouldCadenceFlush,
  type CoalesceState,
} from './coalesce'

const VIN = '5YJ3TESTVIN000001'

function newState(): CoalesceState {
  return new Map()
}

describe('applyMessage — boundary detection', () => {
  it('fires a boundary on Gear P→D (drive START)', () => {
    const s = newState()
    // start parked
    expect(applyMessage(s, VIN, 'Gear', 'P').boundary).toBe(false)
    // shift to drive → active edge
    const r = applyMessage(s, VIN, 'Gear', 'D')
    expect(r.boundary).toBe(true)
    expect(r.changed).toBe(true)
    expect(isActive(getVinState(s, VIN).current)).toBe(true)
  })

  it('fires a boundary on Gear D→P (drive STOP)', () => {
    const s = newState()
    applyMessage(s, VIN, 'Gear', 'D')
    const r = applyMessage(s, VIN, 'Gear', 'P')
    expect(r.boundary).toBe(true)
    expect(isActive(getVinState(s, VIN).current)).toBe(false)
  })

  it('fires a boundary on DetailedChargeState Stopped→Charging', () => {
    const s = newState()
    applyMessage(s, VIN, 'DetailedChargeState', 'Stopped')
    const r = applyMessage(s, VIN, 'DetailedChargeState', 'Charging')
    expect(r.boundary).toBe(true)
  })

  it('does NOT fire a boundary on a non-boundary field', () => {
    const s = newState()
    applyMessage(s, VIN, 'Gear', 'D')
    const r = applyMessage(s, VIN, 'VehicleSpeed', 30)
    expect(r.boundary).toBe(false)
    expect(r.changed).toBe(true)
  })

  it('does NOT fire a boundary on same-state Gear update (D→D)', () => {
    const s = newState()
    applyMessage(s, VIN, 'Gear', 'D')
    const r = applyMessage(s, VIN, 'Gear', 'D')
    expect(r.boundary).toBe(false)
  })

  it('ignores unknown fields (no change, no boundary)', () => {
    const s = newState()
    const r = applyMessage(s, VIN, 'FutureField', 'x')
    expect(r).toEqual({ boundary: false, changed: false })
    expect(getVinState(s, VIN).dirty).toBe(false)
  })
})

describe('buildSnapshot + carry-forward', () => {
  it('builds a full point-in-time snapshot from sparse deltas', () => {
    const s = newState()
    applyMessage(s, VIN, 'Odometer', 12345)
    applyMessage(s, VIN, 'BatteryLevel', 72)
    applyMessage(s, VIN, 'Gear', 'D')
    applyMessage(s, VIN, 'VehicleSpeed', 40)
    applyMessage(s, VIN, 'Location', { latitude: 1.23, longitude: 4.56 })

    const snap = buildSnapshot(getVinState(s, VIN), '2026-06-21T10:00:00.000Z')!
    expect(snap).toBeTruthy()
    expect(snap.odometer).toBe(12345)
    expect(snap.battery_level).toBe(72)
    expect(snap.shift_state).toBe('D')
    expect(snap.speed).toBe(40)
    expect(snap.latitude).toBe(1.23)
    expect(snap.gps_as_of).toBe('2026-06-21T10:00:00.000Z')
    expect(snap.importSource).toBe('telemetry')
    // tpms always null in telemetry mode
    expect(snap.tpms_fl).toBeNull()
  })

  it('carries slow fields forward across a flush (does not reset on markFlushed)', () => {
    const s = newState()
    applyMessage(s, VIN, 'Odometer', 100)
    applyMessage(s, VIN, 'BatteryLevel', 80)
    const vs = getVinState(s, VIN)
    markFlushed(vs, Date.now())
    expect(vs.dirty).toBe(false)

    // a later sparse delta (only speed) still produces a snapshot with carried odo/level
    applyMessage(s, VIN, 'VehicleSpeed', 25)
    const snap = buildSnapshot(vs, '2026-06-21T10:05:00.000Z')!
    expect(snap.odometer).toBe(100) // carried forward
    expect(snap.battery_level).toBe(80) // carried forward
    expect(snap.speed).toBe(25)
  })

  it('returns null for an insane recordedAt', () => {
    const s = newState()
    applyMessage(s, VIN, 'BatteryLevel', 50)
    expect(buildSnapshot(getVinState(s, VIN), '1980-01-01T00:00:00.000Z')).toBeNull()
  })
})

describe('shouldCadenceFlush', () => {
  it('does not flush when not dirty', () => {
    const s = newState()
    const vs = getVinState(s, VIN)
    expect(shouldCadenceFlush(vs, Date.now(), 20, 60)).toBe(false)
  })

  it('flushes idle interval when parked + dirty', () => {
    const s = newState()
    applyMessage(s, VIN, 'BatteryLevel', 50) // idle (no gear/charging)
    const vs = getVinState(s, VIN)
    vs.lastFlushAt = 0
    // 70s elapsed, idle interval 60s → flush
    expect(shouldCadenceFlush(vs, 70_000, 20, 60)).toBe(true)
    // 10s elapsed → not yet
    expect(shouldCadenceFlush(vs, 10_000, 20, 60)).toBe(false)
  })

  it('uses the ACTIVE interval when driving', () => {
    const s = newState()
    applyMessage(s, VIN, 'Gear', 'D') // active
    const vs = getVinState(s, VIN)
    vs.lastFlushAt = 0
    // 25s elapsed, active interval 20s → flush; would NOT flush on idle(60s)
    expect(shouldCadenceFlush(vs, 25_000, 20, 60)).toBe(true)
  })

  it('markFlushed clears dirty and stamps lastFlushAt', () => {
    const s = newState()
    applyMessage(s, VIN, 'BatteryLevel', 50)
    const vs = getVinState(s, VIN)
    expect(vs.dirty).toBe(true)
    markFlushed(vs, 123_456)
    expect(vs.dirty).toBe(false)
    expect(vs.lastFlushAt).toBe(123_456)
    expect(shouldCadenceFlush(vs, 123_456 + 100_000, 20, 60)).toBe(false) // not dirty
  })
})
