/**
 * VehiclePoller — the per-VIN "active-burst" Durable Object.
 *
 * Cloudflare cron floors at 1 minute, so to poll every ~20–30s while a car is
 * actively driving/charging we use a Durable Object that re-arms its own alarm.
 * The cron (baseline + watchdog) arms this DO whenever it sees a car active; the
 * DO then tight-polls until the car is no longer driving/charging, closes the
 * session (behind hysteresis, so transient blips don't split sessions), and stops
 * — handing idle/asleep back to the cron so the car sleeps normally.
 *
 * Disabled by default (BURST_POLL var). When off, the cron never arms this and the
 * poller behaves exactly as it always has.
 *
 * Notes:
 *  - Each alarm()/fetch() is its own execution context, so we bridge bindings →
 *    process.env here too, and build a FRESH db client per call via withDb (a
 *    Worker I/O object can't cross contexts).
 *  - The loop's branching (hysteresis, failure breaker, cadence) lives in the pure
 *    decideBurstAction (see lib/burst-vm.ts) so it's unit-tested.
 *  - Classic DO style + minimal local types: avoids pulling in @cloudflare/workers
 *    -types; the runtime supplies the real DurableObjectState/storage.
 */
import { bridgeEnv } from './env-bridge'
import { withDb } from './db'
import { serverEnv } from './env'
import { createTeslaClient, listVehicles } from './tesla/client.server'
import { closeOpenSessions, emptyPollSummary, pollVehicleStep } from './poller'
import { decideBurstAction, type PollMode } from '../lib/burst-vm'

const HYSTERESIS = 2 // consecutive inactive polls before closing + stopping
const MAX_FAILS = 5 // consecutive failed polls before the circuit breaker trips
const KICK_DELAY_MS = 1000 // first poll shortly after arming
const RETRY_DELAY_MS = 30_000 // catch-block re-arm if an alarm errors before its re-arm
const COOLDOWN_MS = 5 * 60_000 // after a failure-breaker stop, ignore re-arms this long
const KEY = 'loop'
const COOLDOWN_KEY = 'cooldownUntil'

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
}
interface DurableState {
  storage: DurableStorage
}

interface LoopState {
  userId: string
  vin: string
  streak: number
  fails: number
  cadenceS: number
}

export class VehiclePoller {
  private storage: DurableStorage
  private env: Record<string, unknown>

  constructor(state: DurableState, env: Record<string, unknown>) {
    this.storage = state.storage
    this.env = env
  }

  /** Armed by the cron watchdog (POST { userId, vin }). Idempotent. */
  async fetch(req: Request): Promise<Response> {
    bridgeEnv(this.env)
    // Honour a failure-breaker cooldown: while it's active, refuse to resurrect the
    // loop, so a persistent outage can't become a re-arm/retry loop driven by the
    // every-2-min watchdog. The open session (if any) is preserved meanwhile.
    const cooldownUntil = await this.storage.get<number>(COOLDOWN_KEY)
    if (cooldownUntil != null && Date.now() < cooldownUntil) {
      return new Response('cooling down', { status: 200 })
    }
    await this.storage.delete(COOLDOWN_KEY)

    const { userId, vin } = (await req.json()) as { userId: string; vin: string }
    const cfg = serverEnv.burstPoll()
    const cur = await this.storage.get<LoopState>(KEY)
    await this.storage.put<LoopState>(KEY, {
      userId,
      vin,
      streak: cur?.streak ?? 0,
      fails: cur?.fails ?? 0,
      cadenceS: cur?.cadenceS ?? cfg.driveS,
    })
    // Start the loop only if it isn't already running (a live loop keeps its alarm).
    if ((await this.storage.getAlarm()) == null) {
      await this.storage.setAlarm(Date.now() + KICK_DELAY_MS)
    }
    return new Response('ok')
  }

  async alarm(): Promise<void> {
    bridgeEnv(this.env)
    // alarm() must NEVER throw uncaught: a storage/DB hiccup mustn't permanently
    // kill the loop. Two backstops — the early re-arm below keeps the 20s cadence
    // if the poll throws, and the cron watchdog re-arms us within ~2 min if even
    // the re-arm/persist throws (this whole body is wrapped). On a clean stop we
    // clear the alarm so the loop ends.
    try {
      const s = await this.storage.get<LoopState>(KEY)
      if (!s) return // nothing armed — go dormant
      const st = s

      // Re-arm the NEXT tick before the fallible poll, so a hung/throwing poll
      // can't silently end the loop (overwritten with the chosen cadence below).
      await this.storage.setAlarm(Date.now() + st.cadenceS * 1000)

      const cfg = serverEnv.burstPoll()
      if (!cfg.enabled) {
        // Burst turned off mid-run — close out and stop.
        await withDb((db) => closeOpenSessions(db, st.userId, st.vin)).catch(() => {})
        await this.stop()
        return
      }

      let mode: PollMode
      try {
        mode = await withDb(async (db) => {
          const ctx = await createTeslaClient(db, st.userId)
          const vehicles = await listVehicles(ctx)
          const v = vehicles.find((x) => x.vin === st.vin)
          if (!v) return 'offline' as PollMode
          return pollVehicleStep(db, st.userId, ctx, v, emptyPollSummary(), /* debounceClose */ true)
        })
      } catch {
        mode = 'error'
      }

      const d = decideBurstAction(
        mode,
        { streak: st.streak, fails: st.fails },
        { driveS: cfg.driveS, chargeS: cfg.chargeS, hysteresis: HYSTERESIS, maxFails: MAX_FAILS },
      )

      if (d.action === 'stop') {
        if (d.reason === 'failures') {
          // Circuit breaker tripped (car unreachable / downstream outage). Leave any
          // open session for the cron reaper and cool down so the watchdog doesn't
          // immediately resurrect us into a retry loop; auto-revives after COOLDOWN.
          await this.stopCooldown()
        } else {
          if (d.closeSessions) {
            await withDb((db) => closeOpenSessions(db, st.userId, st.vin)).catch(() => {})
          }
          await this.stop()
        }
        return
      }

      await this.storage.put<LoopState>(KEY, {
        ...st,
        streak: d.state.streak,
        fails: d.state.fails,
        cadenceS: d.nextCadenceS,
      })
      await this.storage.setAlarm(Date.now() + d.nextCadenceS * 1000)
    } catch (e) {
      // Never propagate. Best-effort re-arm so an error BEFORE the early re-arm (e.g.
      // the initial storage.get) still retries soon instead of waiting on the cron
      // watchdog; if this too fails, the watchdog revives us within ~2 min. (A loop
      // that legitimately stopped returns normally and never reaches this catch.)
      console.error('VehiclePoller alarm error', e)
      await this.storage.setAlarm(Date.now() + RETRY_DELAY_MS).catch(() => {})
    }
  }

  private async stop(): Promise<void> {
    await this.storage.deleteAlarm()
    await this.storage.delete(KEY)
  }

  /** Stop after the failure breaker, recording a cooldown the cron arm respects. */
  private async stopCooldown(): Promise<void> {
    await this.storage.deleteAlarm()
    await this.storage.delete(KEY)
    await this.storage.put<number>(COOLDOWN_KEY, Date.now() + COOLDOWN_MS)
  }
}
