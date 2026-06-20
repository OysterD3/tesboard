/**
 * Centralized TanStack Query options for every dashboard data source. Each wraps
 * an existing server function (no backend changes). Route loaders call
 * `queryClient.ensureQueryData(...)` to prefetch (router hover-intent preload still
 * works); components read the same options via `useQuery`/`useSuspenseQuery` and
 * hit the cache. Mutations invalidate by the matching key.
 */
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { getDashboardData } from '../functions/dashboard-data.functions'
import { getAnalyticsData } from '../functions/analytics-data.functions'
import { getBatteryHealth } from '../functions/battery.functions'
import { getAnomalies } from '../functions/anomalies.functions'
import { getChargingLocations } from '../functions/locations.functions'
import { getDriveDetail, type DriveDetailPayload } from '../functions/drive-detail.functions'
import { getChargeSessionDetail, type ChargeDetailPayload } from '../functions/charge-detail.functions'
import { getIdleDetail, type IdleDetailPayload } from '../functions/idle-detail.functions'

// undefined search param → null so the cache key is stable across renders.
const vinKey = (vin?: string | null) => vin ?? null
const vinArg = (vin?: string | null) => (vin ? { vin } : {})

export const dashboardQuery = (vin?: string | null) =>
  queryOptions({
    queryKey: ['dashboard', vinKey(vin)],
    queryFn: () => getDashboardData({ data: vinArg(vin) }),
  })

export const analyticsQuery = (vin?: string | null) =>
  queryOptions({
    queryKey: ['analytics', vinKey(vin)],
    queryFn: () => getAnalyticsData({ data: vinArg(vin) }),
  })

export const batteryQuery = (vin?: string | null) =>
  queryOptions({
    queryKey: ['battery', vinKey(vin)],
    queryFn: () => getBatteryHealth({ data: vinArg(vin) }),
  })

export const anomaliesQuery = (vin?: string | null) =>
  queryOptions({
    queryKey: ['anomalies', vinKey(vin)],
    queryFn: () => getAnomalies({ data: vinArg(vin) }),
  })

export const locationsQuery = (vin?: string | null) =>
  queryOptions({
    queryKey: ['locations', vinKey(vin)],
    queryFn: () => getChargingLocations({ data: vinArg(vin) }),
  })

// Detail queries: the server fns have strict positive-int validators, so an
// invalid id must short-circuit to the empty payload (matching the prior loaders'
// guard) rather than throw.
const EMPTY_DRIVE: DriveDetailPayload = { drive: null, samples: [], points: [], sampled: false, estCost: null }
export const driveDetailQuery = (driveId: number) =>
  queryOptions({
    queryKey: ['driveDetail', driveId],
    queryFn: () =>
      Number.isInteger(driveId) && driveId > 0 ? getDriveDetail({ data: { driveId } }) : Promise.resolve(EMPTY_DRIVE),
  })

const EMPTY_CHARGE: ChargeDetailPayload = { charge: null, samples: [], point: null, odometerMi: null, sinceLastChargeMi: null }
export const chargeDetailQuery = (sessionId: number) =>
  queryOptions({
    queryKey: ['chargeDetail', sessionId],
    queryFn: () =>
      Number.isInteger(sessionId) && sessionId > 0
        ? getChargeSessionDetail({ data: { sessionId } })
        : Promise.resolve(EMPTY_CHARGE),
  })

const EMPTY_IDLE: IdleDetailPayload = {
  found: false, prevDriveId: 0, vin: null, startedAt: null, endedAt: null, place: null, point: null,
  startBattery: null, endBattery: null, startRangeMi: null, endRangeMi: null, effWhPerMi: null, packKwh: null,
  chargerKwh: null, cost: null, states: [], samples: [],
}
export const idleDetailQuery = (prevDriveId: number) =>
  queryOptions({
    queryKey: ['idleDetail', prevDriveId],
    queryFn: () =>
      Number.isInteger(prevDriveId) && prevDriveId > 0
        ? getIdleDetail({ data: { prevDriveId } })
        : Promise.resolve(EMPTY_IDLE),
  })

/**
 * Shared accessor for the aggregate dashboard data. Reads the SAME query the
 * `/dashboard` loader prefetched (cache hit — no refetch), so child routes
 * (drives/charging/idles/overview/insights/maps) stay reactive to invalidation.
 * vin comes from the dashboard route search so the key matches the loader deps.
 */
const dashRoute = getRouteApi('/dashboard')
export function useDashboardData() {
  const { vin } = dashRoute.useSearch()
  return useSuspenseQuery(dashboardQuery(vin)).data
}
