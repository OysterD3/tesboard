import { createFileRoute } from '@tanstack/react-router'
import { getChargingLocations } from '../../functions/locations.functions'
import { EmptyState, StatCard, dateTime, kwh, money } from '../../components/Stat'
import { kw } from '../../lib/charge-location'

export const Route = createFileRoute('/dashboard/locations')({
  loader: () => getChargingLocations(),
  component: LocationsPage,
})

function LocationsPage() {
  const { locations } = Route.useLoaderData()
  const totalEnergy = locations.reduce((s, l) => s + l.totalEnergyKwh, 0)
  const mostVisited = locations[0] ?? null

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Locations" value={locations.length.toLocaleString()} />
        <StatCard
          label="Most visited"
          value={mostVisited ? mostVisited.label : '—'}
          sub={mostVisited ? `${mostVisited.visitCount} visits` : undefined}
        />
        <StatCard label="Total energy" value={kwh(totalEnergy)} />
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">Charging locations</h2>
        {locations.length === 0 ? (
          <EmptyState>
            No charging locations yet. They build up as the poller observes charging and Supercharger
            site names backfill from Tesla’s billing. Coordinates are grouped locally and never sent
            to any third party.
          </EmptyState>
        ) : (
          <div className="island-shell overflow-x-auto rounded-2xl">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-[var(--sea-ink-soft)]">
                  <Th>Location</Th>
                  <Th>Visits</Th>
                  <Th>Total energy</Th>
                  <Th>Avg / visit</Th>
                  <Th>Avg speed</Th>
                  <Th>Avg cost / kWh</Th>
                  <Th>Last charged</Th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.key} className="border-t border-[var(--line)]">
                    <Td>{l.label}</Td>
                    <Td>{l.visitCount.toLocaleString()}</Td>
                    <Td>{kwh(l.totalEnergyKwh)}</Td>
                    <Td>{kwh(l.avgEnergyKwh)}</Td>
                    <Td>{kw(l.avgChargeSpeedKw)}</Td>
                    <Td>{l.avgCostPerKwh != null ? money(l.avgCostPerKwh, l.currency) : '—'}</Td>
                    <Td>{dateTime(l.lastChargedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 font-semibold">{children}</th>
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3 text-[var(--sea-ink)]">{children}</td>
}
