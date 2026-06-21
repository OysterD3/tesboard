import { describe, expect, it } from 'vitest'
import {
  clampRange,
  derivePowerKw,
  emptyDerivationState,
  isSaneRecordedAt,
  mapDetailedChargeState,
  mapField,
  mapGear,
  nonNeg,
  parseLocation,
  selectChargeEnergy,
  selectChargerPower,
  toBool,
  toNum,
} from './map-fields'

describe('coercion helpers', () => {
  it('toNum handles numbers, numeric strings, NaN, bool', () => {
    expect(toNum(42)).toBe(42)
    expect(toNum('42.5')).toBe(42.5)
    expect(toNum('  7 ')).toBe(7)
    expect(toNum('nope')).toBeNull()
    expect(toNum(Number.NaN)).toBeNull()
    expect(toNum(null)).toBeNull()
    expect(toNum('')).toBeNull()
  })

  it('toBool handles bool, strings, numbers', () => {
    expect(toBool(true)).toBe(true)
    expect(toBool('false')).toBe(false)
    expect(toBool('1')).toBe(true)
    expect(toBool(0)).toBe(false)
    expect(toBool('maybe')).toBeNull()
    expect(toBool(null)).toBeNull()
  })

  it('clampRange drops out-of-range and NaN', () => {
    expect(clampRange(50, 0, 100)).toBe(50)
    expect(clampRange(150, 0, 100)).toBeNull()
    expect(clampRange(-1, 0, 100)).toBeNull()
    expect(clampRange('NaN', 0, 100)).toBeNull()
  })

  it('nonNeg rejects negatives', () => {
    expect(nonNeg(5)).toBe(5)
    expect(nonNeg(0)).toBe(0)
    expect(nonNeg(-3)).toBeNull()
  })
})

describe('enum maps', () => {
  it('mapDetailedChargeState normalizes to Tesla strings', () => {
    expect(mapDetailedChargeState('Charging')).toBe('Charging')
    expect(mapDetailedChargeState('DetailedChargeStateCharging')).toBe('Charging')
    expect(mapDetailedChargeState('Starting')).toBe('Charging')
    expect(mapDetailedChargeState('Complete')).toBe('Stopped')
    expect(mapDetailedChargeState('NoPower')).toBe('Stopped')
    expect(mapDetailedChargeState('Disconnected')).toBe('Stopped')
    expect(mapDetailedChargeState('')).toBeNull()
  })

  it('mapGear maps to P/R/N/D/null', () => {
    expect(mapGear('D')).toBe('D')
    expect(mapGear('Drive')).toBe('D')
    expect(mapGear('GearR')).toBe('R')
    expect(mapGear('N')).toBe('N')
    expect(mapGear('P')).toBe('P')
    expect(mapGear('SNA')).toBeNull()
    expect(mapGear('Invalid')).toBeNull()
    expect(mapGear('')).toBeNull()
  })
})

describe('parseLocation', () => {
  it('accepts object and JSON-string forms', () => {
    expect(parseLocation({ latitude: 1.5, longitude: -2.5 })).toEqual({
      latitude: 1.5,
      longitude: -2.5,
    })
    expect(parseLocation('{"latitude":10,"longitude":20}')).toEqual({
      latitude: 10,
      longitude: 20,
    })
  })

  it('rejects out-of-range / malformed', () => {
    expect(parseLocation({ latitude: 91, longitude: 0 })).toBeNull()
    expect(parseLocation({ latitude: 0, longitude: 181 })).toBeNull()
    expect(parseLocation('not json')).toBeNull()
    expect(parseLocation(null)).toBeNull()
  })
})

describe('derivations', () => {
  it('power_kw = PackVoltage × PackCurrent / 1000', () => {
    const d = emptyDerivationState()
    d.packVoltage = 400
    d.packCurrent = 100
    expect(derivePowerKw(d)).toBe(40)
    d.packCurrent = null
    expect(derivePowerKw(d)).toBeNull()
  })

  it('selectChargerPower prefers DC when nonzero', () => {
    const d = emptyDerivationState()
    d.acPower = 7
    d.dcPower = 0
    expect(selectChargerPower(d)).toBe(7)
    d.dcPower = 120
    expect(selectChargerPower(d)).toBe(120)
    expect(selectChargerPower(emptyDerivationState())).toBeNull()
  })

  it('selectChargeEnergy prefers DC when active', () => {
    const d = emptyDerivationState()
    d.acEnergy = 3
    expect(selectChargeEnergy(d)).toBe(3)
    d.dcEnergy = 40
    expect(selectChargeEnergy(d)).toBe(40)
  })
})

describe('mapField', () => {
  it('maps Soc to usable_battery_level with clamp', () => {
    const d = emptyDerivationState()
    expect(mapField('Soc', 80, d)).toEqual({ usable_battery_level: 80 })
    expect(mapField('Soc', 200, d)).toBeNull() // dropped, out of range
  })

  it('maps Gear, emitting null for parked (boundary edge needs it)', () => {
    const d = emptyDerivationState()
    expect(mapField('Gear', 'D', d)).toEqual({ shift_state: 'D' })
    expect(mapField('Gear', 'P', d)).toEqual({ shift_state: 'P' })
    expect(mapField('Gear', 'SNA', d)).toEqual({ shift_state: null })
  })

  it('maps DetailedChargeState, emitting Stopped even on close', () => {
    const d = emptyDerivationState()
    expect(mapField('DetailedChargeState', 'Charging', d)).toEqual({ charging_state: 'Charging' })
    expect(mapField('DetailedChargeState', 'Complete', d)).toEqual({ charging_state: 'Stopped' })
  })

  it('maps PackVoltage/PackCurrent to power_kw incrementally', () => {
    const d = emptyDerivationState()
    expect(mapField('PackVoltage', 400, d)).toEqual({ power_kw: null }) // current unknown yet
    expect(mapField('PackCurrent', 50, d)).toEqual({ power_kw: 20 })
  })

  it('rounds charger voltage/current/phases to integers', () => {
    const d = emptyDerivationState()
    expect(mapField('ChargerVoltage', 239.6, d)).toEqual({ charger_voltage: 240 })
    expect(mapField('ChargeAmps', 31.4, d)).toEqual({ charger_actual_current: 31 })
    expect(mapField('ChargerPhases', 3, d)).toEqual({ charger_phases: 3 })
  })

  it('bool-ifies HvacPower', () => {
    const d = emptyDerivationState()
    expect(mapField('HvacPower', 0, d)).toEqual({ is_climate_on: false })
    expect(mapField('HvacPower', 1500, d)).toEqual({ is_climate_on: true })
  })

  it('ignores unknown fields (forward-compat)', () => {
    expect(mapField('SomeFutureField', 'x', emptyDerivationState())).toBeNull()
  })
})

describe('isSaneRecordedAt', () => {
  it('accepts in-range, rejects out-of-range', () => {
    expect(isSaneRecordedAt('2026-06-21T00:00:00.000Z')).toBe(true)
    expect(isSaneRecordedAt('1999-01-01T00:00:00.000Z')).toBe(false)
    expect(isSaneRecordedAt('2200-01-01T00:00:00.000Z')).toBe(false)
    expect(isSaneRecordedAt('garbage')).toBe(false)
  })
})
