/**
 * Telemetry adapter boot + wiring (the ONLY file that touches mqtt / postgres).
 *
 * Flow (spec §5):
 *   load .env → loadConfig → getDirectDb (DIRECT_URL, :5432) → build vin→userId
 *   cache from the `vehicle` table → connect MQTT → subscribe
 *   `{base}/+/v/#` (signals) + `{base}/+/connectivity` → run the per-VIN coalescer
 *   → on each flush: insertSnapshot → updateChargeSession → updateDriveSession
 *   (debounceClose:true) → recordStateTransition (from connectivity).
 *
 * Security: every sessionizer call is (vin,user_id)-scoped. The adapter holds
 * direct DB creds that BYPASS RLS, so the ONLY ownership guard is resolving
 * user_id from the TRUSTED `vehicle` table — NEVER from the stream. A VIN absent
 * from `vehicle` is refused (a rogue cert can't stream into another user's rows).
 */
import 'dotenv/config'
import mqtt from 'mqtt'
import { eq } from 'drizzle-orm'

import { loadConfig, type AdapterConfig } from './config'
import { getDirectDb, type DirectDb, type DirectDbHandle } from './db'
import { applyMessage, buildSnapshot, getVinState, markFlushed, shouldCadenceFlush } from './coalesce'
import type { CoalesceState } from './coalesce'
import { vehicle } from '@core/schema'
import {
  emptyPollSummary,
  insertSnapshot,
  updateChargeSession,
  updateDriveSession,
  recordStateTransition,
  reapStaleSessions,
} from '@core/sessionize'
import { flagTelemetrySilent } from '@core/liveness'

/** How often to re-read vin→userId ownership so a re-linked vehicle stops writing to the old owner. */
const CACHE_REWARM_MS = 30 * 60_000

// ── vin → userId resolution (the ownership guard) ─────────────────────────────
class VinResolver {
  private cache = new Map<string, string>()
  // Refused-VIN cache (vin → expiry ms). A forged/garbage VIN streaming flat-out
  // must NOT cost one DB round-trip per message — refuse from memory until the TTL
  // lets us re-check (in case the VIN gets legitimately linked later).
  private negCache = new Map<string, number>()
  private static NEG_TTL_MS = 5 * 60_000

  constructor(private db: DirectDb) {}

  /** (Re)load all known VINs from the trusted `vehicle` table; clears both caches. */
  async warm(): Promise<void> {
    const rows = await this.db
      .select({ vin: vehicle.vin, user_id: vehicle.user_id })
      .from(vehicle)
    this.cache.clear()
    this.negCache.clear() // a previously-unknown VIN may now be linked
    for (const r of rows) this.cache.set(r.vin, r.user_id)
    console.log(`[adapter] vin→userId cache warmed: ${this.cache.size} vehicle(s)`)
  }

  /**
   * Resolve a VIN to its owning user_id, or null if unknown. On a cache miss
   * re-query (a vehicle may have been linked after startup) before refusing, then
   * negative-cache the refusal. NEVER derives user_id from the stream.
   */
  async resolve(vin: string): Promise<string | null> {
    const hit = this.cache.get(vin)
    if (hit) return hit
    const negUntil = this.negCache.get(vin)
    if (negUntil != null) {
      if (negUntil > Date.now()) return null // recently refused — don't re-query
      this.negCache.delete(vin)
    }
    const [row] = await this.db
      .select({ user_id: vehicle.user_id })
      .from(vehicle)
      .where(eq(vehicle.vin, vin))
      .limit(1)
    if (!row) {
      this.negCache.set(vin, Date.now() + VinResolver.NEG_TTL_MS)
      return null
    }
    this.cache.set(vin, row.user_id)
    return row.user_id
  }
}

// ── topic parsing ─────────────────────────────────────────────────────────────
interface ParsedTopic {
  kind: 'signal' | 'connectivity' | 'other'
  vin: string
  field?: string
}

/** Parse `{base}/{vin}/v/{Field}` or `{base}/{vin}/connectivity`. */
export function parseTopic(topic: string, topicBase: string): ParsedTopic | null {
  const parts = topic.split('/')
  // expect base/vin/...; tolerate a base that itself contains '/'.
  const baseParts = topicBase.split('/')
  for (let i = 0; i < baseParts.length; i++) {
    if (parts[i] !== baseParts[i]) return null
  }
  const rest = parts.slice(baseParts.length)
  const vin = rest[0]
  if (!vin) return null
  if (rest[1] === 'v' && rest[2]) {
    return { kind: 'signal', vin, field: rest.slice(2).join('/') }
  }
  if (rest[1] === 'connectivity') {
    return { kind: 'connectivity', vin }
  }
  return { kind: 'other', vin }
}

/** Map a connectivity payload to a coarse vehicle_state. connected→online, else offline. */
function connectivityToState(payload: string): { connected: boolean; state: string } {
  const t = payload.trim().toLowerCase()
  let connected = false
  try {
    const obj = JSON.parse(payload)
    if (obj && typeof obj === 'object') {
      const status = String((obj as Record<string, unknown>).status ?? '').toLowerCase()
      const conn = (obj as Record<string, unknown>).connected
      connected =
        status === 'connected' ||
        status === 'online' ||
        conn === true ||
        conn === 'true'
    }
  } catch {
    connected = t === 'connected' || t === 'online' || t === 'true' || t === '1'
  }
  return { connected, state: connected ? 'online' : 'offline' }
}

// ── the adapter ───────────────────────────────────────────────────────────────
class Adapter {
  private state: CoalesceState = new Map()
  private cadenceTimers = new Map<string, NodeJS.Timeout>()
  private resolver: VinResolver
  private client: mqtt.MqttClient | null = null
  // Serialize flushes per VIN so two near-simultaneous flushes (boundary + timer)
  // don't race the open/close session logic.
  private flushChains = new Map<string, Promise<void>>()

  constructor(
    private cfg: AdapterConfig,
    private dbHandle: DirectDbHandle,
  ) {
    this.resolver = new VinResolver(dbHandle.db)
  }

  async start(): Promise<void> {
    await this.resolver.warm()
    this.client = mqtt.connect(this.cfg.mqttUrl, {
      clientId: this.cfg.mqttClientId,
      reconnectPeriod: 5000,
      connectTimeout: 30_000,
      clean: true,
    })

    this.client.on('connect', () => {
      console.log(`[adapter] connected to broker ${this.cfg.mqttUrl}`)
      const subs = [`${this.cfg.topicBase}/+/v/#`, `${this.cfg.topicBase}/+/connectivity`]
      for (const t of subs) {
        this.client!.subscribe(t, { qos: 1 }, (err) => {
          if (err) console.error(`[adapter] subscribe failed for ${t}:`, err.message)
          else console.log(`[adapter] subscribed ${t}`)
        })
      }
    })

    this.client.on('reconnect', () => console.log('[adapter] reconnecting to broker…'))
    this.client.on('error', (err) => console.error('[adapter] mqtt error:', err.message))
    this.client.on('message', (topic, payload) => {
      // Fire-and-forget; errors are caught inside so one bad message can't crash.
      void this.onMessage(topic, payload.toString('utf8'))
    })

    // Per-VIN cadence timer: a single global tick checks every VIN's interval.
    const tick = setInterval(() => void this.cadenceTick(), 5000)
    this.cadenceTimers.set('__global__', tick)

    // Periodically re-read ownership so a re-linked/transferred vehicle stops
    // writing to the prior owner (the cache otherwise only grows over the process
    // lifetime).
    const rewarm = setInterval(
      () =>
        void this.resolver
          .warm()
          .catch((e) => console.error('[adapter] cache re-warm:', (e as Error).message)),
      CACHE_REWARM_MS,
    )
    this.cadenceTimers.set('__rewarm__', rewarm)
  }

  private async onMessage(topic: string, payload: string): Promise<void> {
    try {
      const parsed = parseTopic(topic, this.cfg.topicBase)
      if (!parsed || parsed.kind === 'other') return

      const userId = await this.resolver.resolve(parsed.vin)
      if (!userId) {
        // Refuse: a VIN not present in `vehicle` is not ours to write.
        console.warn(`[adapter] refusing unknown VIN ${parsed.vin} (not in vehicle table)`)
        return
      }

      if (parsed.kind === 'connectivity') {
        await this.onConnectivity(parsed.vin, userId, payload)
        return
      }

      // signal
      const res = applyMessage(this.state, parsed.vin, parsed.field!, payload)
      if (res.boundary) {
        // Drive/charge START/STOP edge — flush immediately, don't debounce away.
        await this.flush(parsed.vin, userId)
      }
    } catch (e) {
      console.error('[adapter] onMessage error:', (e as Error).message)
    }
  }

  private async onConnectivity(vin: string, userId: string, payload: string): Promise<void> {
    const { connected, state } = connectivityToState(payload)
    const summary = emptyPollSummary()
    try {
      await recordStateTransition(this.dbHandle.db, userId, vin, state, summary)
    } catch (e) {
      console.error(`[adapter] recordStateTransition ${vin}:`, (e as Error).message)
    }
    if (!connected) {
      // Connectivity STOP: flush what we have, then handle a still-open session.
      await this.flush(vin, userId)
      const s = getVinState(this.state, vin)
      if (s.sessionOpen) {
        // Drive-granular self-report: the stream dropped mid-drive/charge. Raise the
        // immediate (event-based) silence flag; the hourly cron is the backstop for
        // adapter/VM-down. Dedup is shared (one flag per vin per hour).
        try {
          await flagTelemetrySilent(this.dbHandle.db, userId, vin, {
            message:
              'Connectivity dropped with an open session — the telemetry stream may have been interrupted mid-drive/charge.',
          })
        } catch (e) {
          console.error(`[adapter] flagTelemetrySilent ${vin}:`, (e as Error).message)
        }
        // Reap any session left open by the drop.
        try {
          await reapStaleSessions(this.dbHandle.db, userId, vin, summary)
        } catch (e) {
          console.error(`[adapter] reapStaleSessions ${vin}:`, (e as Error).message)
        }
      }
    }
  }

  /** Cadence tick: flush every dirty VIN whose interval has elapsed. */
  private async cadenceTick(): Promise<void> {
    const now = Date.now()
    for (const [vin, s] of this.state) {
      if (shouldCadenceFlush(s, now, this.cfg.flushIntervalActiveS, this.cfg.flushIntervalIdleS)) {
        const userId = await this.resolver.resolve(vin)
        if (!userId) continue
        await this.flush(vin, userId)
      }
    }
  }

  /**
   * Flush the coalesced snapshot for a VIN through the sessionizer. Serialized
   * per VIN via a promise chain so boundary + cadence flushes never interleave.
   */
  private flush(vin: string, userId: string): Promise<void> {
    const prev = this.flushChains.get(vin) ?? Promise.resolve()
    const next = prev.then(() => this.doFlush(vin, userId)).catch((e) => {
      console.error(`[adapter] flush ${vin}:`, (e as Error).message)
    })
    this.flushChains.set(vin, next)
    return next
  }

  private async doFlush(vin: string, userId: string): Promise<void> {
    const s = getVinState(this.state, vin)
    if (!s.dirty) return // nothing new (a boundary flush may have just run)
    const recordedAt = new Date().toISOString()
    const snap = buildSnapshot(s, recordedAt)
    if (!snap) return
    const db = this.dbHandle.db
    const summary = emptyPollSummary()

    const insertErr = await insertSnapshot(db, userId, vin, snap)
    if (insertErr) {
      console.error(`[adapter] insertSnapshot ${vin}: ${insertErr}`)
      return // don't run sessionization on a failed snapshot
    }
    // Mark flushed only after a successful snapshot insert (carry-forward fields).
    markFlushed(s, Date.parse(recordedAt))

    // Telemetry is the sole writer (like the burst DO) → debounceClose:true so the
    // sessionizer's hysteresis still smooths transient blips.
    try {
      await updateChargeSession(db, userId, vin, snap, summary, true)
    } catch (e) {
      console.error(`[adapter] updateChargeSession ${vin}:`, (e as Error).message)
    }
    try {
      await updateDriveSession(db, userId, vin, snap, summary, true)
    } catch (e) {
      console.error(`[adapter] updateDriveSession ${vin}:`, (e as Error).message)
    }
    // Track whether we believe a session is open (for disconnect-time reaping).
    s.sessionOpen = snap.charging_state === 'Charging' || isDriving(snap.shift_state)

    if (summary.errors.length) {
      for (const err of summary.errors) console.warn(`[adapter] ${vin}: ${err}`)
    }
  }

  async stop(): Promise<void> {
    for (const t of this.cadenceTimers.values()) clearInterval(t)
    this.cadenceTimers.clear()
    if (this.client) {
      await new Promise<void>((resolve) => this.client!.end(false, {}, () => resolve()))
    }
    // Drain in-flight flush chains before closing the DB.
    await Promise.allSettled([...this.flushChains.values()])
    await this.dbHandle.close()
  }
}

function isDriving(shift: string | null): boolean {
  return shift === 'D' || shift === 'R' || shift === 'N'
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig()
  const dbHandle = getDirectDb(cfg.directUrl)
  const adapter = new Adapter(cfg, dbHandle)

  const shutdown = async (sig: string) => {
    console.log(`[adapter] ${sig} received — shutting down…`)
    try {
      await adapter.stop()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await adapter.start()
  console.log('[adapter] running')
}

main().catch((e) => {
  console.error('[adapter] fatal:', (e as Error).message)
  process.exit(1)
})
