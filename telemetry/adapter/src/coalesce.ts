/**
 * PURE per-VIN coalescing state machine.
 *
 * NO mqtt / postgres / db imports — fully unit-testable. index.ts wires it to the
 * broker (input) and the sessionizer (output); this file only decides WHAT to
 * flush and WHEN, building a complete `SnapshotInput` from sparse delta signals.
 *
 * Why coalesce (spec §5): Fleet Telemetry fans each signal to its own MQTT topic,
 * firing on-change capped by interval. The sessionizer expects REST-style
 * point-in-time snapshots (a full row every cadence). So we accumulate per-field
 * deltas into `current[vin]` and emit a snapshot:
 *   1. on a drive/charge BOUNDARY edge (Gear or DetailedChargeState crossing
 *      active↔inactive) — immediate, so START/STOP isn't debounced away;
 *   2. on a per-VIN CADENCE timer (active vs idle interval) when dirty — batches
 *      the sparse deltas into one row matching REST granularity;
 *   3. on connectivity STOP — flush what we have before the stream goes quiet.
 *
 * Carry-forward: slow fields (odometer, battery_level, battery_range,
 * usable_battery_level) persist across flushes so each emitted snapshot is a true
 * point-in-time row, not a sparse delta. We DON'T reset `current[vin]` after a
 * flush — we only clear `dirty`.
 */
import type { SnapshotInput } from '@core/sessionize'
import {
  emptyDerivationState,
  isSaneRecordedAt,
  mapField,
  type DerivationState,
  type FieldPatch,
} from './map-fields'

/** Per-VIN coalescing state. */
export interface VinState {
  /** Accumulated last-known field values (carried forward across flushes). */
  current: Partial<SnapshotInput>
  /** Cross-field derivation inputs (PackV/PackI, AC/DC power+energy). */
  deriv: DerivationState
  /** epoch ms of the last flush (0 = never). */
  lastFlushAt: number
  /** Was the VIN active (driving OR charging) as of the last applied message? */
  lastActive: boolean
  /** Have fields changed since the last flush? */
  dirty: boolean
  /** Is there an open session per our own bookkeeping (for liveness on disconnect)? */
  sessionOpen: boolean
}

export type CoalesceState = Map<string, VinState>

export function emptyVinState(): VinState {
  return {
    current: {},
    deriv: emptyDerivationState(),
    lastFlushAt: 0,
    lastActive: false,
    dirty: false,
    sessionOpen: false,
  }
}

/** Get-or-create the per-VIN slot. */
export function getVinState(state: CoalesceState, vin: string): VinState {
  let s = state.get(vin)
  if (!s) {
    s = emptyVinState()
    state.set(vin, s)
  }
  return s
}

/** Is this coalesced snapshot "active" (driving or charging)? */
export function isActive(c: Partial<SnapshotInput>): boolean {
  const shift = c.shift_state
  const driving = shift === 'D' || shift === 'R' || shift === 'N'
  const charging = c.charging_state === 'Charging'
  return driving || charging
}

export interface ApplyResult {
  /** A boundary edge (active↔inactive) was crossed — caller should flush NOW. */
  boundary: boolean
  /** The field changed the coalesced state (dirty was set). */
  changed: boolean
}

/**
 * Apply one decoded message `{vin, field, value}` to the state.
 * Mutates `state`. Returns whether a boundary edge occurred (immediate flush) and
 * whether the snapshot became dirty. PURE w.r.t. I/O.
 */
export function applyMessage(
  state: CoalesceState,
  vin: string,
  field: string,
  value: unknown,
): ApplyResult {
  const s = getVinState(state, vin)
  const patch: FieldPatch | null = mapField(field, value, s.deriv)
  if (patch == null) return { boundary: false, changed: false }

  // Detect active-edge BEFORE applying (boundary fires only when this very field
  // is one that can change the active/inactive verdict: Gear or DetailedChargeState).
  const wasActive = isActive(s.current)
  Object.assign(s.current, patch)
  const nowActive = isActive(s.current)
  const isBoundaryField = field === 'Gear' || field === 'DetailedChargeState'
  const boundary = isBoundaryField && wasActive !== nowActive

  s.lastActive = nowActive
  s.dirty = true
  return { boundary, changed: true }
}

/**
 * Build a complete point-in-time SnapshotInput from the carried-forward state.
 * `recordedAt` is the caller's clock (ISO). Fields never seen are null (the
 * sessionizer + aggregate window tolerate nulls). Returns null if recordedAt is
 * out of the sane range (defensive — caller passes its own clock).
 */
export function buildSnapshot(s: VinState, recordedAt: string): SnapshotInput | null {
  if (!isSaneRecordedAt(recordedAt)) return null
  const c = s.current
  return {
    recordedAt,
    odometer: c.odometer ?? null,
    battery_level: c.battery_level ?? null,
    usable_battery_level: c.usable_battery_level ?? null,
    battery_range: c.battery_range ?? null,
    est_battery_range: c.est_battery_range ?? null,
    charge_energy_added: c.charge_energy_added ?? null,
    charging_state: c.charging_state ?? null,
    charger_power: c.charger_power ?? null,
    shift_state: c.shift_state ?? null,
    inside_temp: c.inside_temp ?? null,
    outside_temp: c.outside_temp ?? null,
    // No telemetry source for tpms in the lean set — always null (import-only).
    tpms_fl: null,
    tpms_fr: null,
    tpms_rl: null,
    tpms_rr: null,
    latitude: c.latitude ?? null,
    longitude: c.longitude ?? null,
    speed: c.speed ?? null,
    charger_voltage: c.charger_voltage ?? null,
    charger_actual_current: c.charger_actual_current ?? null,
    charger_phases: c.charger_phases ?? null,
    power_kw: c.power_kw ?? null,
    sentry_mode: c.sentry_mode ?? null,
    is_climate_on: c.is_climate_on ?? null,
    is_preconditioning: c.is_preconditioning ?? null,
    // gps_as_of mirrors recordedAt: telemetry locations are live, not stale.
    gps_as_of: c.latitude != null && c.longitude != null ? recordedAt : null,
    raw_json: { ...c, _source: 'telemetry' },
    importSource: 'telemetry',
  }
}

/**
 * Should the per-VIN cadence timer flush now? True when dirty AND the active/idle
 * interval has elapsed since the last flush. (Boundary + connectivity flushes are
 * driven separately and bypass this.)
 */
export function shouldCadenceFlush(
  s: VinState,
  nowMs: number,
  activeIntervalS: number,
  idleIntervalS: number,
): boolean {
  if (!s.dirty) return false
  const intervalMs = (s.lastActive ? activeIntervalS : idleIntervalS) * 1000
  return nowMs - s.lastFlushAt >= intervalMs
}

/**
 * Mark the state flushed at `nowMs`. CARRY FORWARD all current field values
 * (don't reset `current`) — only clear `dirty` and stamp `lastFlushAt`. This is
 * what makes each emitted row a true point-in-time snapshot.
 */
export function markFlushed(s: VinState, nowMs: number): void {
  s.dirty = false
  s.lastFlushAt = nowMs
}
