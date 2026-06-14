/**
 * Authenticated, READ-ONLY Tesla Fleet API client.
 *
 * Hard rule: this client NEVER calls wake_up or any command endpoint. Reads on a
 * sleeping car return 408 and do NOT wake it — callers treat 408 as "asleep".
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { teslaAccount } from '../schema'
import { getValidAccessToken } from './token-store'
import type {
  TeslaChargingHistoryRecord,
  TeslaVehicleData,
  TeslaVehicleListItem,
} from './types'

export const ASLEEP = Symbol('asleep')

/** Resolve the per-user Fleet API base URL (region-specific), with a fallback. */
export async function resolveBaseUrl(db: Db, userId: string): Promise<string> {
  const rows = await db
    .select({ fleet_api_base_url: teslaAccount.fleet_api_base_url })
    .from(teslaAccount)
    .where(eq(teslaAccount.user_id, userId))
    .limit(1)
  return rows[0]?.fleet_api_base_url || process.env.TESLA_FLEET_BASE_URL || ''
}

interface ClientCtx {
  db: Db
  userId: string
  baseUrl: string
}

export async function createTeslaClient(db: Db, userId: string): Promise<ClientCtx> {
  const baseUrl = await resolveBaseUrl(db, userId)
  if (!baseUrl) throw new Error('No Fleet API base URL resolved for user.')
  return { db, userId, baseUrl }
}

async function authedGet<T>(ctx: ClientCtx, path: string): Promise<T | typeof ASLEEP> {
  const doFetch = async (forceRefresh = false) => {
    const token = await getValidAccessToken(ctx.db, ctx.userId, forceRefresh)
    return fetch(`${ctx.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
  }
  let res = await doFetch()
  // 408 = vehicle asleep/unavailable (reading does NOT wake it). Surface, don't retry.
  if (res.status === 408) return ASLEEP
  // 401 once → force a real token refresh (not just the expiry-gated one) and retry.
  if (res.status === 401) res = await doFetch(true)
  if (res.status === 408) return ASLEEP
  if (!res.ok) {
    throw new Error(`Fleet API GET ${path} failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

/** GET /api/1/vehicles — cheap list; read `state` before deciding to poll. */
export async function listVehicles(ctx: ClientCtx): Promise<TeslaVehicleListItem[]> {
  const json = (await authedGet<{ response: TeslaVehicleListItem[] }>(ctx, '/api/1/vehicles')) as {
    response: TeslaVehicleListItem[]
  }
  return json.response ?? []
}

const VEHICLE_DATA_ENDPOINTS =
  'charge_state;drive_state;vehicle_state;climate_state;gui_settings;location_data'

/**
 * GET /api/1/vehicles/{id}/vehicle_data — full snapshot.
 * Returns ASLEEP if the car is sleeping (408), so the poller can back off.
 */
export async function getVehicleData(
  ctx: ClientCtx,
  teslaId: string,
): Promise<TeslaVehicleData | typeof ASLEEP> {
  const result = await authedGet<{ response: TeslaVehicleData }>(
    ctx,
    `/api/1/vehicles/${teslaId}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_DATA_ENDPOINTS)}`,
  )
  if (result === ASLEEP) return ASLEEP
  return result.response
}

/** GET /api/1/dx/charging/history — paginated Supercharger / Tesla-billed sessions. */
export async function getChargingHistory(
  ctx: ClientCtx,
  opts: { vin: string; pageNo?: number; pageSize?: number },
): Promise<TeslaChargingHistoryRecord[] | typeof ASLEEP> {
  const params = new URLSearchParams({
    vin: opts.vin,
    pageNo: String(opts.pageNo ?? 1),
    pageSize: String(opts.pageSize ?? 50),
  })
  const result = await authedGet<{ data?: TeslaChargingHistoryRecord[]; response?: TeslaChargingHistoryRecord[] }>(
    ctx,
    `/api/1/dx/charging/history?${params.toString()}`,
  )
  // Propagate ASLEEP so the caller can distinguish "transient 408" from "no data"
  // and avoid silently terminating pagination on a clean run.
  if (result === ASLEEP) return ASLEEP
  // Tesla has returned this list under `data` or `response` across versions.
  return result.data ?? result.response ?? []
}
