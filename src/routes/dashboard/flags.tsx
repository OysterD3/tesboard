import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { dismissAnomaly } from '../../functions/anomalies.functions'
import { anomaliesQuery } from '../../lib/queries'
import { EmptyState, dateTime } from '../../components/Stat'
import { useDisplayTz } from '../../lib/use-hydrated'
import { cn } from '../../lib/utils'
import type { AnomalyFlag } from '../../types/db'

export const Route = createFileRoute('/dashboard/flags')({
  loaderDeps: ({ search }) => ({ vin: (search as { vin?: string }).vin }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(anomaliesQuery(deps.vin)),
  component: FlagsPage,
})

const TYPE_LABEL: Record<string, string> = {
  slow_charge: 'Slow charge',
  efficiency_drop: 'Efficiency drop',
}

function FlagsPage() {
  const { flags } = useSuspenseQuery(anomaliesQuery(Route.useLoaderDeps().vin)).data
  const open = flags.filter((f) => f.dismissed_at == null)
  const dismissed = flags.filter((f) => f.dismissed_at != null)

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">Anomaly flags</h2>
        {open.length === 0 ? (
          <EmptyState>
            No anomalies detected. Flags appear here when a charge is unusually slow for a location or
            a drive’s efficiency drops well below your usual. These are notify-only — nothing is sent
            to the car.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {open.map((f) => (
              <FlagRow key={f.id} flag={f} />
            ))}
          </div>
        )}
      </section>

      {dismissed.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--sea-ink-soft)]">Dismissed</h2>
          <div className="flex flex-col gap-3 opacity-60">
            {dismissed.map((f) => (
              <FlagRow key={f.id} flag={f} dismissed />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function FlagRow({ flag, dismissed }: { flag: AnomalyFlag; dismissed?: boolean }) {
  const tz = useDisplayTz()
  const queryClient = useQueryClient()
  const dismiss = useMutation({
    mutationFn: (id: number) => dismissAnomaly({ data: { id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['anomalies'] }),
  })
  const isWarning = flag.severity === 'warning'

  return (
    <article className="island-shell flex items-start justify-between gap-4 rounded-2xl p-4">
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink)]',
              isWarning ? 'bg-[rgba(180,83,9,0.16)]' : 'bg-[rgba(79,184,178,0.18)]',
            )}
          >
            {TYPE_LABEL[flag.type] ?? flag.type}
          </span>
          <span className="text-xs text-[var(--sea-ink-soft)]">{dateTime(flag.created_at, tz)}</span>
        </div>
        <p className="m-0 text-sm text-[var(--sea-ink)]">{flag.message}</p>
      </div>
      {!dismissed && (
        <button
          onClick={() => dismiss.mutate(flag.id)}
          disabled={dismiss.isPending}
          className="shrink-0 rounded-full border border-[var(--line)] bg-white/50 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5 disabled:opacity-60"
        >
          {dismiss.isPending ? '…' : 'Dismiss'}
        </button>
      )}
    </article>
  )
}
