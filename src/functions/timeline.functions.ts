/**
 * Unified chronological event log (drives, charges, sleep/state changes, firmware
 * updates) — TeslaMate's Timeline. Read-only; authMiddleware + user_id scoped.
 */
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, gte } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { getDb } from '../server/db'
import { chargeSession, driveSession, softwareUpdate, vehicleState } from '../server/schema'
import { mergeTimeline, type TimelineEvent } from '../lib/analytics-vm'

const input = z.object({ vin: z.string().optional(), days: z.number().int().min(1).max(365).default(30) })

export const getTimeline = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(input)
  .handler(async ({ data, context }): Promise<TimelineEvent[]> => {
    const db = getDb()
    const uid = context.userId
    const vin = data.vin
    const since = new Date(Date.now() - data.days * 86400_000).toISOString()
    const lim = 200

    const [drives, charges, states, updates] = await Promise.all([
      db
        .select({ at: driveSession.started_at, dist: driveSession.distance_mi, dur: driveSession.duration_s })
        .from(driveSession)
        .where(and(eq(driveSession.user_id, uid), vin ? eq(driveSession.vin, vin) : undefined, gte(driveSession.started_at, since)))
        .orderBy(desc(driveSession.started_at))
        .limit(lim),
      db
        .select({ at: chargeSession.started_at, energy: chargeSession.energy_added_kwh, loc: chargeSession.charge_location_type })
        .from(chargeSession)
        .where(and(eq(chargeSession.user_id, uid), vin ? eq(chargeSession.vin, vin) : undefined, gte(chargeSession.started_at, since)))
        .orderBy(desc(chargeSession.started_at))
        .limit(lim),
      db
        .select({ at: vehicleState.started_at, state: vehicleState.state })
        .from(vehicleState)
        .where(and(eq(vehicleState.user_id, uid), vin ? eq(vehicleState.vin, vin) : undefined, gte(vehicleState.started_at, since)))
        .orderBy(desc(vehicleState.started_at))
        .limit(lim),
      db
        .select({ at: softwareUpdate.started_at, version: softwareUpdate.version })
        .from(softwareUpdate)
        .where(and(eq(softwareUpdate.user_id, uid), vin ? eq(softwareUpdate.vin, vin) : undefined, gte(softwareUpdate.started_at, since)))
        .orderBy(desc(softwareUpdate.started_at))
        .limit(lim),
    ])

    const events: TimelineEvent[] = [
      ...drives.map((d): TimelineEvent => ({
        kind: 'drive',
        at: d.at,
        title: 'Drive',
        detail: [d.dist != null ? `${d.dist.toFixed(1)} mi` : null, d.dur != null ? `${Math.round(d.dur / 60)} min` : null]
          .filter(Boolean)
          .join(' · '),
      })),
      ...charges.map((c): TimelineEvent => ({
        kind: 'charge',
        at: c.at,
        title: 'Charge',
        detail: [c.energy != null ? `${c.energy.toFixed(1)} kWh` : null, c.loc].filter(Boolean).join(' · '),
      })),
      ...states.map((s): TimelineEvent => ({ kind: 'state', at: s.at, title: s.state })),
      ...updates.map((u): TimelineEvent => ({ kind: 'update', at: u.at, title: 'Software update', detail: u.version ?? undefined })),
    ]
    return mergeTimeline(events).slice(0, 300)
  })
