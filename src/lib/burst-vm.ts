/**
 * Pure decision logic for the burst poller (the per-VIN Durable Object that
 * tight-polls while the car is driving/charging). No DB, no Cloudflare APIs — the
 * DO feeds in the latest poll outcome + its persisted counters and this decides
 * the next move, so the loop's behaviour (hysteresis, failure backoff, cadence)
 * is unit-testable. See vehicle-poller.ts for the side-effecting shell.
 */

/** Outcome of a single poll cycle, as seen by the burst loop. */
export type PollMode = 'driving' | 'charging' | 'idle' | 'asleep' | 'offline' | 'error'

/** Counters the DO persists between alarms. */
export interface BurstState {
  /** Consecutive inactive (not driving/charging) polls — drives close hysteresis. */
  streak: number
  /** Consecutive failed polls — drives the circuit breaker. */
  fails: number
}

export interface BurstConfig {
  driveS: number
  chargeS: number
  /** Consecutive inactive polls required before closing the session + stopping. */
  hysteresis: number
  /** Consecutive failures before giving up (the cron watchdog then recovers). */
  maxFails: number
}

export interface BurstDecision {
  action: 'continue' | 'stop'
  /** Seconds until the next alarm (only meaningful when action === 'continue'). */
  nextCadenceS: number
  /** Close any open drive/charge session before stopping. */
  closeSessions: boolean
  /**
   * Why the loop stopped (only set when action === 'stop'). 'inactive' = the car
   * parked/slept (a clean stop); 'failures' = the circuit breaker tripped — the
   * caller should COOL DOWN before letting the watchdog revive it, so a persistent
   * outage doesn't become a re-arm/retry loop.
   */
  reason?: 'inactive' | 'failures'
  state: BurstState
}

/**
 * Decide the burst loop's next move from the latest poll outcome.
 *
 *  - driving/charging  → keep looping at the drive/charge cadence; reset counters.
 *  - inactive (idle/asleep/offline) → debounce: only after `hysteresis` consecutive
 *    inactive polls do we close the session and stop. This guards against a
 *    transient shift_state=null / charging="Stopped" blip splitting one session
 *    into many at the tight cadence. While debouncing we re-poll fast (driveS) to
 *    confirm the stop quickly.
 *  - error → count failures; after `maxFails` consecutive, STOP without closing
 *    (the car may still be active — let the cron watchdog revive us / the reaper
 *    close a truly stuck session) so a downstream outage can't become a retry storm.
 */
export function decideBurstAction(
  mode: PollMode,
  state: BurstState,
  cfg: BurstConfig,
): BurstDecision {
  if (mode === 'error') {
    const fails = state.fails + 1
    const stop = fails >= cfg.maxFails
    return {
      action: stop ? 'stop' : 'continue',
      nextCadenceS: cfg.driveS,
      closeSessions: false, // leave the session open — a transient outage resumes it (no split)
      reason: stop ? 'failures' : undefined,
      state: { streak: state.streak, fails },
    }
  }

  if (mode === 'driving') {
    return { action: 'continue', nextCadenceS: cfg.driveS, closeSessions: false, state: { streak: 0, fails: 0 } }
  }
  if (mode === 'charging') {
    return { action: 'continue', nextCadenceS: cfg.chargeS, closeSessions: false, state: { streak: 0, fails: 0 } }
  }

  // inactive: idle / asleep / offline
  const streak = state.streak + 1
  if (streak >= cfg.hysteresis) {
    return { action: 'stop', nextCadenceS: cfg.driveS, closeSessions: true, reason: 'inactive', state: { streak, fails: 0 } }
  }
  return { action: 'continue', nextCadenceS: cfg.driveS, closeSessions: false, state: { streak, fails: 0 } }
}
