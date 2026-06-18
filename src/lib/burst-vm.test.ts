import { describe, expect, it } from 'vitest'
import { decideBurstAction, type BurstConfig } from './burst-vm'

const cfg: BurstConfig = { driveS: 20, chargeS: 30, hysteresis: 2, maxFails: 5 }
const fresh = { streak: 0, fails: 0 }

describe('decideBurstAction', () => {
  it('keeps looping at the drive cadence while driving, resetting counters', () => {
    const d = decideBurstAction('driving', { streak: 1, fails: 3 }, cfg)
    expect(d).toEqual({ action: 'continue', nextCadenceS: 20, closeSessions: false, state: { streak: 0, fails: 0 } })
  })

  it('uses the slower charge cadence while charging', () => {
    const d = decideBurstAction('charging', fresh, cfg)
    expect(d.action).toBe('continue')
    expect(d.nextCadenceS).toBe(30)
  })

  it('debounces an inactive blip — does NOT close on the first inactive poll', () => {
    const d = decideBurstAction('idle', fresh, cfg)
    expect(d.action).toBe('continue')
    expect(d.closeSessions).toBe(false)
    expect(d.state.streak).toBe(1) // building toward hysteresis
    expect(d.nextCadenceS).toBe(20) // re-poll fast to confirm
  })

  it('closes + stops once inactive for `hysteresis` consecutive polls', () => {
    const d = decideBurstAction('asleep', { streak: 1, fails: 0 }, cfg)
    expect(d).toEqual({ action: 'stop', nextCadenceS: 20, closeSessions: true, reason: 'inactive', state: { streak: 2, fails: 0 } })
  })

  it('a single active poll resets the inactive streak (no premature close)', () => {
    // streak was 1 (one inactive blip); a driving poll resets it to 0.
    expect(decideBurstAction('driving', { streak: 1, fails: 0 }, cfg).state.streak).toBe(0)
  })

  it('treats offline like inactive (counts toward hysteresis)', () => {
    expect(decideBurstAction('offline', fresh, cfg).state.streak).toBe(1)
  })

  it('keeps going on a transient error below the failure cap', () => {
    const d = decideBurstAction('error', { streak: 0, fails: 3 }, cfg)
    expect(d.action).toBe('continue')
    expect(d.state.fails).toBe(4)
    expect(d.closeSessions).toBe(false)
  })

  it('trips the circuit breaker after maxFails consecutive errors, without closing', () => {
    const d = decideBurstAction('error', { streak: 0, fails: 4 }, cfg)
    expect(d.action).toBe('stop')
    expect(d.state.fails).toBe(5)
    expect(d.closeSessions).toBe(false) // leave the session for the cron watchdog / reaper
    expect(d.reason).toBe('failures') // signals the DO to cool down before re-arm
  })

  it('a successful poll clears accumulated failures', () => {
    expect(decideBurstAction('charging', { streak: 0, fails: 4 }, cfg).state.fails).toBe(0)
  })
})
