/**
 * Drive-granular liveness check.
 *
 * Runs on the hourly reconcile cron (in BOTH ingest modes, but it matters most in
 * telemetry mode, which has no REST fallback). For each vehicle that is online (or
 * has a recent open session) but whose last ingested snapshot is older than
 * LIVENESS_SILENCE_MIN (default 15), it raises a `telemetry_silent` anomaly so the
 * silence surfaces in the existing Analytics/anomaly UI.
 *
 * Idempotency: the standard anomaly partial-unique indexes key on a related
 * charge/drive id, which a silence flag has neither of. So we dedup MANUALLY on
 * (vin, type, coarse hour bucket): one flag per vehicle per hour, so a persistent
 * outage doesn't spam a row every reconcile tick.
 *
 * Every read/write is user_id-scoped (RLS is enabled-with-no-policy; the predicate
 * is the only tenant isolation).
 */
import { and, eq, gte, isNull } from 'drizzle-orm'
import type { Db } from './db'
import { anomalyFlag, driveSession, vehicle } from './schema'

const DEFAULT_SILENCE_MIN = 15

/** UTC hour bucket (ISO truncated to the hour) — the dedup key for a silence flag. */
function hourBucket(d = new Date()): string {
  return `${d.toISOString().slice(0, 13)}:00:00Z`
}

/**
 * Flag VINs that are online/mid-session but have gone silent past the threshold.
 * Returns the number of flags inserted (for logging/tests). Best-effort per
 * vehicle — one vehicle's error never aborts the rest.
 */
export async function checkLiveness(db: Db): Promise<number> {
  const silenceMin = numFromEnv('LIVENESS_SILENCE_MIN', DEFAULT_SILENCE_MIN)
  const now = Date.now()
  const bucket = hourBucket(new Date(now))

  const vehicles = await db
    .select({
      vin: vehicle.vin,
      user_id: vehicle.user_id,
      last_state: vehicle.last_state,
      last_ingest_at: vehicle.last_ingest_at,
    })
    .from(vehicle)

  let inserted = 0
  for (const v of vehicles) {
    try {
      const hasOpen = await hasRecentOpenSession(db, v.vin, v.user_id)
      // Consider only cars we'd EXPECT to be ingesting: online, or mid-session.
      if (v.last_state !== 'online' && !hasOpen) continue
      // No ingest yet at all → nothing to compare against (don't flag a never-seen car).
      if (v.last_ingest_at == null) continue
      // Still ingesting recently → healthy.
      if (new Date(v.last_ingest_at).getTime() > now - silenceMin * 60_000) continue

      const silentMin = Math.round((now - new Date(v.last_ingest_at).getTime()) / 60_000)
      const did = await flagTelemetrySilent(db, v.user_id, v.vin, {
        message: `No telemetry received for ~${silentMin} min while online — the vehicle may have gone silent.`,
        observedMin: silentMin,
        lastIngestAt: v.last_ingest_at,
        bucket,
      })
      if (did) inserted++
    } catch {
      /* best-effort; next hourly tick retries */
    }
  }
  return inserted
}

/** Does the vehicle have an open (un-ended) drive session right now? */
async function hasRecentOpenSession(db: Db, vin: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: driveSession.id })
    .from(driveSession)
    .where(and(eq(driveSession.vin, vin), eq(driveSession.user_id, userId), isNull(driveSession.ended_at)))
    .limit(1)
  return rows.length > 0
}

/**
 * Raise a `telemetry_silent` anomaly unless one already exists for this (vin, type)
 * in the current hour bucket. Returns true if a row was inserted.
 *
 * Shared by two callers: the hourly cron (`checkLiveness`, duration-based — "silent
 * for ~N min") and the telemetry adapter (event-based — connectivity dropped with an
 * open session). One flag per (vin, hour) keeps a flapping stream or a persistent
 * outage from spamming a row on every tick/reconnect. The bucket dedup is a
 * read-then-insert; both callers are effectively single-flight per vin so there is no
 * race worth a unique index for a notify-only flag.
 *
 * `db` is structurally the app's `Db` (same Drizzle schema) — the Node adapter passes
 * its direct-pg client, which the type system accepts.
 */
export async function flagTelemetrySilent(
  db: Db,
  userId: string,
  vin: string,
  opts: {
    message: string
    observedMin?: number | null
    lastIngestAt?: string | null
    bucket?: string
  },
): Promise<boolean> {
  const bucket = opts.bucket ?? hourBucket()
  const existing = await db
    .select({ id: anomalyFlag.id })
    .from(anomalyFlag)
    .where(
      and(
        eq(anomalyFlag.user_id, userId),
        eq(anomalyFlag.vin, vin),
        eq(anomalyFlag.type, 'telemetry_silent'),
        gte(anomalyFlag.created_at, bucket),
      ),
    )
    .limit(1)
  if (existing.length > 0) return false

  await db.insert(anomalyFlag).values({
    vin,
    user_id: userId,
    type: 'telemetry_silent',
    severity: 'warning',
    message: opts.message,
    observed: opts.observedMin ?? null,
    baseline: null,
    detail: { bucket, last_ingest_at: opts.lastIngestAt ?? null },
  })
  return true
}

/**
 * Read a positive integer env var at CALL TIME (per the project's env discipline:
 * never read process.env at module scope, so the value resolves per-cron-cycle).
 */
function numFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
