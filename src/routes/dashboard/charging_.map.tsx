import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDashboardData } from '../../lib/queries'
import { SectionRouteMap } from '../../components/dashboard/SectionRouteMap'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { clusterChargePoints } from '../../lib/map-vm'
import { filterByRange, lastChargeMsOf, resolveRange } from '../../lib/range-filter'

export const Route = createFileRoute('/dashboard/charging_/map')({
  component: ChargingMapPage,
})

/**
 * Dedicated full-screen charge map (`/dashboard/charging/map`). Un-nested from
 * the Charging list (the `charging_` prefix) so it renders edge-to-edge in the
 * dashboard shell; the History/Map toggle + back button navigate to the list.
 * Charge places come straight from the already-loaded sessions (clustered within
 * 150m) — no extra fetch. Shared map scaffolding lives in <SectionRouteMap>.
 */
function ChargingMapPage() {
  const { charging, now } = useDashboardData()
  const { range } = useDash()
  const navigate = useNavigate()

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const resolved = useMemo(() => resolveRange(range, nowMs, lastChargeMs), [range, nowMs, lastChargeMs])
  const points = useMemo(
    () => clusterChargePoints(filterByRange(charging.sessions, resolved)),
    [charging.sessions, resolved],
  )
  const totalCharges = useMemo(() => points.reduce((s, p) => s + p.count, 0), [points])

  const hasPoints = points.length > 0

  return (
    <SectionRouteMap
      section="charging"
      onBack={() => navigate({ to: '/dashboard/charging', search: (prev) => prev })}
      nowMs={nowMs}
      lastChargeMs={lastChargeMs}
      points={points}
      hasContent={hasPoints}
      caption={
        hasPoints
          ? `${points.length} location${points.length === 1 ? '' : 's'} · ${totalCharges} charge${totalCharges === 1 ? '' : 's'} · charges within 150m merge; tap a place to zoom in`
          : null
      }
      emptyMessage="No charge locations yet — sessions need a recorded location to map."
    />
  )
}
