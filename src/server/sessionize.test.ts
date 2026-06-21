/**
 * Unit tests for the runtime-agnostic sessionizer.
 *
 * The repo has no live-DB test harness (existing server tests are pure), so we
 * drive the sessionizer with a tiny hand-built fake `Db` that:
 *  - returns staged SELECT result-sets in FIFO order (the functions issue their
 *    reads in a fixed, deterministic sequence), and
 *  - records every INSERT/UPDATE so we can assert on the values written.
 *
 * This exercises the real sessionization JS — open/close decisions, the energy
 * hysteresis (never lower a running total), and aggregateSnapshots' math — without
 * needing Postgres or any where-clause evaluation. Drizzle's `where/orderBy/limit`
 * are opaque chain calls here; the staged FIFO stands in for what they'd return.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateSnapshots,
  priorWasActive,
  updateChargeSession,
  updateDriveSession,
  emptyPollSummary,
  type SnapshotInput,
} from './sessionize'
import type { Db } from './db'

// ── a minimal staged fake Db ──────────────────────────────────────────────────
interface Write {
  kind: 'insert' | 'update'
  table: string
  values?: Record<string, unknown>
  set?: Record<string, unknown>
}

function makeFakeDb(selectQueue: unknown[][]) {
  const writes: Write[] = []
  let qi = 0
  const nextRows = (): unknown[] => (qi < selectQueue.length ? selectQueue[qi++] : [])
  const tableName = (t: unknown): string =>
    // Drizzle table objects carry their SQL name on a well-known symbol; fall back
    // to a guess for the test (we mostly assert on values, not the name).
    (t as { [k: symbol]: unknown })?.constructor?.name ?? 'unknown'

  // A thenable chain: every builder method returns `this`; awaiting resolves to the
  // next staged result-set. limit() also resolves (some callers await .limit()).
  const selectChain = () => {
    const chain: Record<string, unknown> = {}
    const ret = () => chain
    chain.from = ret
    chain.where = ret
    chain.orderBy = ret
    chain.limit = () => Promise.resolve(nextRows())
    chain.then = (res: (v: unknown[]) => void) => res(nextRows())
    return chain
  }

  const db = {
    select: (_cols?: unknown) => selectChain(),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ kind: 'insert', table: tableName(table), values })
        return Promise.resolve()
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          writes.push({ kind: 'update', table: tableName(table), set })
          return Promise.resolve()
        },
      }),
    }),
  }
  return { db: db as unknown as Db, writes }
}

function snap(o: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    recordedAt: '2026-06-21T00:00:00.000Z',
    odometer: null,
    battery_level: null,
    usable_battery_level: null,
    battery_range: null,
    est_battery_range: null,
    charge_energy_added: null,
    charging_state: null,
    charger_power: null,
    shift_state: null,
    inside_temp: null,
    outside_temp: null,
    tpms_fl: null,
    tpms_fr: null,
    tpms_rl: null,
    tpms_rr: null,
    latitude: null,
    longitude: null,
    speed: null,
    charger_voltage: null,
    charger_actual_current: null,
    charger_phases: null,
    power_kw: null,
    sentry_mode: null,
    is_climate_on: null,
    is_preconditioning: null,
    gps_as_of: null,
    raw_json: null,
    ...o,
  }
}

const U = 'user-1'
const VIN = 'VIN1'

describe('priorWasActive', () => {
  it('returns false when there is no prior snapshot', async () => {
    const { db } = makeFakeDb([[]]) // the one SELECT returns no rows
    expect(await priorWasActive(db, VIN, U, '2026-06-21T00:00:00Z', 'drive')).toBe(false)
  })

  it('treats D/R/N as driving and P as not', async () => {
    const d1 = makeFakeDb([[{ shift: 'D', charging: null }]])
    expect(await priorWasActive(d1.db, VIN, U, 'x', 'drive')).toBe(true)
    const d2 = makeFakeDb([[{ shift: 'R', charging: null }]])
    expect(await priorWasActive(d2.db, VIN, U, 'x', 'drive')).toBe(true)
    const d3 = makeFakeDb([[{ shift: 'P', charging: null }]])
    expect(await priorWasActive(d3.db, VIN, U, 'x', 'drive')).toBe(false)
  })

  it('treats charging_state=Charging as active for charge', async () => {
    const c1 = makeFakeDb([[{ shift: 'P', charging: 'Charging' }]])
    expect(await priorWasActive(c1.db, VIN, U, 'x', 'charge')).toBe(true)
    const c2 = makeFakeDb([[{ shift: 'P', charging: 'Stopped' }]])
    expect(await priorWasActive(c2.db, VIN, U, 'x', 'charge')).toBe(false)
  })
})

describe('aggregateSnapshots', () => {
  it('returns nulls for an empty window', async () => {
    const { db } = makeFakeDb([[]])
    const agg = await aggregateSnapshots(db, VIN, U, 'a', 'b')
    expect(agg.startRange).toBeNull()
    expect(agg.endRange).toBeNull()
    expect(agg.maxSpeed).toBeNull()
    expect(agg.avgChargerPower).toBeNull()
    expect(agg.superSnapshotCount).toBe(0)
  })

  it('computes first/last range, levels, max speed, avg temps and super count', async () => {
    const rows = [
      { battery_range: 200, battery_level: 80, charge_energy_added: 0, charger_power: 0, outside_temp: 10, inside_temp: 20, speed: 0, recorded_at: 't1' },
      { battery_range: 150, battery_level: 60, charge_energy_added: 0, charger_power: 0, outside_temp: 20, inside_temp: 22, speed: 65, recorded_at: 't2' },
      { battery_range: 120, battery_level: 48, charge_energy_added: 0, charger_power: 0, outside_temp: 30, inside_temp: 24, speed: 40, recorded_at: 't3' },
    ]
    const { db } = makeFakeDb([rows])
    const agg = await aggregateSnapshots(db, VIN, U, 'a', 'b')
    expect(agg.startRange).toBe(200)
    expect(agg.endRange).toBe(120)
    expect(agg.startBatteryLevel).toBe(80)
    expect(agg.endBatteryLevel).toBe(48)
    expect(agg.maxSpeed).toBe(65)
    expect(agg.avgOutsideTemp).toBe(20) // (10+20+30)/3
    expect(agg.avgInsideTemp).toBe(22)
    expect(agg.superSnapshotCount).toBe(0)
  })

  it('counts sustained high-power readings and averages only positive charger power', async () => {
    const rows = [
      { battery_range: 100, battery_level: 30, charge_energy_added: 5, charger_power: 0, outside_temp: null, inside_temp: null, speed: null, recorded_at: 't1' },
      { battery_range: 150, battery_level: 45, charge_energy_added: 12, charger_power: 50, outside_temp: null, inside_temp: null, speed: null, recorded_at: 't2' },
      { battery_range: 200, battery_level: 60, charge_energy_added: 20, charger_power: 60, outside_temp: null, inside_temp: null, speed: null, recorded_at: 't3' },
    ]
    const { db } = makeFakeDb([rows])
    const agg = await aggregateSnapshots(db, VIN, U, 'a', 'b')
    expect(agg.superSnapshotCount).toBe(2) // 50 and 60 kW both >= 25 threshold
    expect(agg.avgChargerPower).toBe(55) // (50+60)/2; the 0 is excluded
  })
})

describe('updateDriveSession', () => {
  it('opens a new drive when shifted to D and none is open', async () => {
    // openSession(driveSession) read → no open row.
    const { db, writes } = makeFakeDb([[]])
    const summary = emptyPollSummary()
    await updateDriveSession(db, U, VIN, snap({ shift_state: 'D', odometer: 1000, battery_level: 70 }), summary)
    const ins = writes.find((w) => w.kind === 'insert')
    expect(ins).toBeTruthy()
    expect(ins!.values).toMatchObject({ vin: VIN, user_id: U, start_odometer: 1000, start_battery_level: 70 })
  })

  it('does not open a drive when parked (P) and none is open', async () => {
    const { db, writes } = makeFakeDb([[]])
    await updateDriveSession(db, U, VIN, snap({ shift_state: 'P' }), emptyPollSummary())
    expect(writes.length).toBe(0)
  })

  it('debounces a single not-driving blip when debounceClose is set and the prior reading was active', async () => {
    // reads in order: openSession(driveSession) → an OPEN row, then priorWasActive → active.
    const { db, writes } = makeFakeDb([
      [{ id: 9, started_at: 's', start_odometer: 0, start_battery_level: 50 }], // openSession
      [{ shift: 'D', charging: null }], // priorWasActive → active → debounce, skip close
    ])
    await updateDriveSession(db, U, VIN, snap({ shift_state: 'P' }), emptyPollSummary(), /* debounceClose */ true)
    // No update/insert: the close was debounced away.
    expect(writes.length).toBe(0)
  })
})

describe('updateChargeSession', () => {
  it('opens a home charge below the supercharger power threshold', async () => {
    const { db, writes } = makeFakeDb([[]]) // openSession → none
    await updateChargeSession(
      db,
      U,
      VIN,
      snap({ charging_state: 'Charging', charger_power: 7, charge_energy_added: 1.2, latitude: 1, longitude: 2 }),
      emptyPollSummary(),
    )
    const ins = writes.find((w) => w.kind === 'insert')
    expect(ins!.values).toMatchObject({ source: 'home', energy_added_kwh: 1.2, lat: 1, lng: 2 })
  })

  it('classifies a high-power start as supercharger', async () => {
    const { db, writes } = makeFakeDb([[]])
    await updateChargeSession(
      db,
      U,
      VIN,
      snap({ charging_state: 'Charging', charger_power: 120, charge_energy_added: 5 }),
      emptyPollSummary(),
    )
    expect(writes.find((w) => w.kind === 'insert')!.values).toMatchObject({ source: 'supercharger' })
  })

  it('never lowers the running energy total on a mid-session counter reset', async () => {
    // openSession → an OPEN charge with 30 kWh already; incoming reads 2 kWh (reset).
    const { db, writes } = makeFakeDb([
      [{ id: 7, energy_added_kwh: 30 }],
    ])
    await updateChargeSession(
      db,
      U,
      VIN,
      snap({ charging_state: 'Charging', charge_energy_added: 2 }),
      emptyPollSummary(),
    )
    const upd = writes.find((w) => w.kind === 'update')
    expect(upd!.set).toMatchObject({ energy_added_kwh: 30 }) // kept the higher value
  })
})
