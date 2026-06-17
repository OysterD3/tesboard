/**
 * Anomaly flags (notify-only). The poller writes flags at session/drive close;
 * these fns read and dismiss them. Reads only Postgres. Every query is
 * user_id-scoped — the predicate is the only tenant isolation (RLS is
 * enabled-with-no-policy).
 */
import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../server/auth-middleware'
import { withDb } from '../server/db'
import { vinFilter } from './vin'
import { anomalyFlag } from '../server/schema'
import type { AnomalyFlag } from '../types/db'

export interface AnomaliesPayload {
  flags: AnomalyFlag[]
  unreadCount: number
}

export const getAnomalies = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(vinFilter)
  .handler(async ({ data, context }): Promise<AnomaliesPayload> =>
    withDb(async (db) => {
    const vin = data?.vin
    const rows = (await db
      .select()
      .from(anomalyFlag)
      .where(and(eq(anomalyFlag.user_id, context.userId), vin ? eq(anomalyFlag.vin, vin) : undefined))
      .orderBy(desc(anomalyFlag.created_at))
      .limit(500)) as AnomalyFlag[]
    return { flags: rows, unreadCount: rows.filter((f) => f.dismissed_at == null).length }
  }))

export const dismissAnomaly = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data, context }): Promise<AnomalyFlag | null> =>
    withDb(async (db) => {
    const rows = await db
      .update(anomalyFlag)
      .set({ dismissed_at: new Date().toISOString() })
      // and() the user_id so a crafted id can't dismiss another user's flag.
      .where(and(eq(anomalyFlag.id, data.id), eq(anomalyFlag.user_id, context.userId)))
      .returning()
    return (rows[0] as AnomalyFlag) ?? null
  }))

export const dismissAllAnomalies = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ dismissed: number }> =>
    withDb(async (db) => {
    const rows = await db
      .update(anomalyFlag)
      .set({ dismissed_at: new Date().toISOString() })
      .where(and(eq(anomalyFlag.user_id, context.userId), isNull(anomalyFlag.dismissed_at)))
      .returning({ id: anomalyFlag.id })
    return { dismissed: rows.length }
  }))
