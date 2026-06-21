/**
 * PURE field-mapping + coercion for decoded Fleet Telemetry MQTT messages.
 *
 * NO mqtt / postgres / db imports — unit-testable without infra.
 *
 * Tesla Fleet Telemetry publishes one signal per MQTT topic
 * (`{topic_base}/{vin}/v/{Field}`), payload = the DECODED value (we run the
 * fleet-telemetry server with `transmit_decoded_records:true` + `prefer_typed:true`).
 * This module turns a single `(Field, rawPayload)` into a typed, clamped,
 * column-targeted update for the per-VIN coalescing state machine (coalesce.ts).
 *
 * Mapping authority: spec §4 (lean field set). Columns target the flat
 * `SnapshotInput` shape from src/server/sessionize.ts.
 */
import type { SnapshotInput } from '@core/sessionize'

/** A coalesce-able patch onto `current[vin]` — one or more SnapshotInput fields. */
export type FieldPatch = Partial<SnapshotInput>

// ── clamping / validation helpers ────────────────────────────────────────────
/** Coerce to a finite number or null. Strings (typed-off) and numbers both ok. */
export function toNum(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Coerce to a boolean or null. Accepts bool, 'true'/'false', 1/0. */
export function toBool(v: unknown): boolean | null {
  if (v == null) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (t === 'true' || t === '1') return true
    if (t === 'false' || t === '0') return false
  }
  return null
}

/** Clamp a finite number into [min,max]; null if absent or out of range. */
export function clampRange(v: unknown, min: number, max: number): number | null {
  const n = toNum(v)
  if (n == null) return null
  return n >= min && n <= max ? n : null
}

/** Non-negative finite number, else null (energy/power/current/voltage/speed). */
export function nonNeg(v: unknown): number | null {
  const n = toNum(v)
  if (n == null) return null
  return n >= 0 ? n : null
}

// ── enum maps (spec §4) ───────────────────────────────────────────────────────
/**
 * DetailedChargeState enum → Tesla-style `charging_state` the sessionizer expects.
 * The sessionizer only treats exactly 'Charging' as active; everything else is
 * "not charging" and triggers (debounced) close.
 *   Charging / Starting → 'Charging'
 *   Complete / Stopped / NoPower / Disconnected → 'Stopped'
 * Values may arrive bare ('Charging') or prefixed
 * ('DetailedChargeStateCharging') depending on proto encoding — handle both.
 */
export function mapDetailedChargeState(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '') return null
  const tail = s.replace(/^DetailedChargeState/i, '').toLowerCase()
  switch (tail) {
    case 'charging':
    case 'starting':
      return 'Charging'
    case 'complete':
    case 'stopped':
    case 'nopower':
    case 'disconnected':
    case 'idle':
      return 'Stopped'
    default:
      return 'Stopped'
  }
}

/**
 * Gear enum → Tesla-style `shift_state` ('P'|'R'|'N'|'D'|null). The sessionizer
 * treats D/R/N as driving and P/null as parked. SNA/Invalid → null (parked).
 * Accepts bare ('D'), word ('Drive'), or prefixed ('GearD').
 */
export function mapGear(v: unknown): 'P' | 'R' | 'N' | 'D' | null {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '') return null
  const tail = s.replace(/^Gear/i, '').toUpperCase()
  switch (tail) {
    case 'P':
    case 'PARK':
      return 'P'
    case 'R':
    case 'REVERSE':
      return 'R'
    case 'N':
    case 'NEUTRAL':
      return 'N'
    case 'D':
    case 'DRIVE':
      return 'D'
    default:
      // SNA / Invalid / unknown → parked (do not start a phantom drive)
      return null
  }
}

/**
 * Parse a `Location` payload into {latitude, longitude}. The decoded
 * `LocationValue` arrives as a JSON object {latitude, longitude}; tolerate a
 * JSON string too. Clamps to valid WGS84 ranges; returns null on bad data.
 */
export function parseLocation(v: unknown): { latitude: number; longitude: number } | null {
  let obj: unknown = v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (obj == null || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const lat = clampRange(o.latitude ?? o.lat, -90, 90)
  const lng = clampRange(o.longitude ?? o.lng, -180, 180)
  if (lat == null || lng == null) return null
  return { latitude: lat, longitude: lng }
}

/**
 * Known telemetry Field names (proto) → the SnapshotInput column(s) they feed.
 * Used by mapField; exported for tests / forward-compat audits.
 */
export const KNOWN_FIELDS = new Set<string>([
  'Location',
  'VehicleSpeed',
  'Gear',
  'Odometer',
  'Soc',
  'BatteryLevel',
  'RatedRange',
  'EstBatteryRange',
  'OutsideTemp',
  'InsideTemp',
  'DetailedChargeState',
  'ACChargingPower',
  'DCChargingPower',
  'ChargerVoltage',
  'ChargeAmps',
  'ChargerPhases',
  'ACChargingEnergyIn',
  'DCChargingEnergyIn',
  'SentryMode',
  'PreconditioningEnabled',
  'HvacPower',
  'PackVoltage',
  'PackCurrent',
])

/**
 * The state map-fields keeps between messages so two-input derivations
 * (power_kw = PackVoltage × PackCurrent / 1000, AC/DC power+energy selection)
 * can be resolved. The coalescer owns one of these per VIN. PURE — no I/O.
 */
export interface DerivationState {
  packVoltage: number | null
  packCurrent: number | null
  acPower: number | null
  dcPower: number | null
  acEnergy: number | null
  dcEnergy: number | null
}

export function emptyDerivationState(): DerivationState {
  return {
    packVoltage: null,
    packCurrent: null,
    acPower: null,
    dcPower: null,
    acEnergy: null,
    dcEnergy: null,
  }
}

/**
 * Map ONE decoded telemetry message into a FieldPatch (the SnapshotInput columns
 * it sets), mutating `deriv` for the cross-field derivations. Returns null for an
 * unknown field (forward-compat: ignore) or a value that fails validation (drop
 * the single field, never the whole snapshot).
 *
 * PURE: only reads the args and the passed `deriv`; no module-level state, no I/O.
 */
export function mapField(field: string, value: unknown, deriv: DerivationState): FieldPatch | null {
  switch (field) {
    case 'Location': {
      const loc = parseLocation(value)
      if (!loc) return null
      // gps_as_of mirrors the snapshot recordedAt at flush; coalescer stamps it.
      return { latitude: loc.latitude, longitude: loc.longitude }
    }
    case 'VehicleSpeed': {
      const speed = nonNeg(value)
      return speed == null ? null : { speed }
    }
    case 'Gear': {
      // Gear can legitimately go to null (parked) — emit the patch even when null
      // so the boundary detector sees the active→inactive edge.
      return { shift_state: mapGear(value) }
    }
    case 'Odometer': {
      const odometer = nonNeg(value)
      return odometer == null ? null : { odometer }
    }
    case 'Soc': {
      const usable_battery_level = clampRange(value, 0, 100)
      return usable_battery_level == null ? null : { usable_battery_level }
    }
    case 'BatteryLevel': {
      const battery_level = clampRange(value, 0, 100)
      return battery_level == null ? null : { battery_level }
    }
    case 'RatedRange': {
      const battery_range = nonNeg(value)
      return battery_range == null ? null : { battery_range }
    }
    case 'EstBatteryRange': {
      const est_battery_range = nonNeg(value)
      return est_battery_range == null ? null : { est_battery_range }
    }
    case 'OutsideTemp': {
      const outside_temp = clampRange(value, -60, 70)
      return outside_temp == null ? null : { outside_temp }
    }
    case 'InsideTemp': {
      const inside_temp = clampRange(value, -60, 90)
      return inside_temp == null ? null : { inside_temp }
    }
    case 'DetailedChargeState': {
      // charging_state can flip to 'Stopped' — emit even then for the boundary edge.
      return { charging_state: mapDetailedChargeState(value) }
    }
    case 'ACChargingPower': {
      deriv.acPower = nonNeg(value)
      return { charger_power: selectChargerPower(deriv) }
    }
    case 'DCChargingPower': {
      deriv.dcPower = nonNeg(value)
      return { charger_power: selectChargerPower(deriv) }
    }
    case 'ChargerVoltage': {
      const charger_voltage = nonNeg(value)
      return charger_voltage == null ? null : { charger_voltage: Math.round(charger_voltage) }
    }
    case 'ChargeAmps': {
      const charger_actual_current = nonNeg(value)
      return charger_actual_current == null
        ? null
        : { charger_actual_current: Math.round(charger_actual_current) }
    }
    case 'ChargerPhases': {
      const charger_phases = nonNeg(value)
      return charger_phases == null ? null : { charger_phases: Math.round(charger_phases) }
    }
    case 'ACChargingEnergyIn': {
      deriv.acEnergy = nonNeg(value)
      return { charge_energy_added: selectChargeEnergy(deriv) }
    }
    case 'DCChargingEnergyIn': {
      deriv.dcEnergy = nonNeg(value)
      return { charge_energy_added: selectChargeEnergy(deriv) }
    }
    case 'SentryMode': {
      const sentry_mode = toBool(value)
      return sentry_mode == null ? null : { sentry_mode }
    }
    case 'PreconditioningEnabled': {
      const is_preconditioning = toBool(value)
      return is_preconditioning == null ? null : { is_preconditioning }
    }
    case 'HvacPower': {
      // HvacPower is a power/enum; bool-ify: any nonzero / "on" → climate on.
      const n = toNum(value)
      if (n != null) return { is_climate_on: n !== 0 }
      const b = toBool(value)
      return b == null ? null : { is_climate_on: b }
    }
    case 'PackVoltage': {
      deriv.packVoltage = toNum(value)
      return { power_kw: derivePowerKw(deriv) }
    }
    case 'PackCurrent': {
      deriv.packCurrent = toNum(value)
      return { power_kw: derivePowerKw(deriv) }
    }
    default:
      // Unknown field → ignore (forward-compat).
      return null
  }
}

/** Prefer DC charger power when present/nonzero, else AC. null if neither. */
export function selectChargerPower(deriv: DerivationState): number | null {
  if (deriv.dcPower != null && deriv.dcPower > 0) return deriv.dcPower
  if (deriv.acPower != null && deriv.acPower > 0) return deriv.acPower
  // Both present but zero → 0 (idle). Both null → null.
  if (deriv.dcPower != null) return deriv.dcPower
  if (deriv.acPower != null) return deriv.acPower
  return null
}

/** Select the active energy counter: DC at a Supercharger, else AC. null if neither. */
export function selectChargeEnergy(deriv: DerivationState): number | null {
  if (deriv.dcEnergy != null && deriv.dcEnergy > 0) return deriv.dcEnergy
  if (deriv.acEnergy != null && deriv.acEnergy > 0) return deriv.acEnergy
  if (deriv.dcEnergy != null) return deriv.dcEnergy
  if (deriv.acEnergy != null) return deriv.acEnergy
  return null
}

/** Drive power_kw = PackVoltage × PackCurrent / 1000. null until both known. */
export function derivePowerKw(deriv: DerivationState): number | null {
  if (deriv.packVoltage == null || deriv.packCurrent == null) return null
  const kw = (deriv.packVoltage * deriv.packCurrent) / 1000
  return Number.isFinite(kw) ? kw : null
}

/**
 * Is a recordedAt ISO string in the sane [2015,2100] range? Mirrors the
 * locationAsOf range guard so the adapter never writes a garbage timestamp.
 */
export function isSaneRecordedAt(iso: string): boolean {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  const year = new Date(t).getUTCFullYear()
  return year >= 2015 && year <= 2100
}
