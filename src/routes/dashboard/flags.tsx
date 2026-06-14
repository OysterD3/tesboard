import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { dismissAnomaly, getAnomalies } from '../../functions/anomalies.functions'
import { EmptyState, dateTime } from '../../components/Stat'
import type { AnomalyFlag } from '../../types/db'

export const Route = createFileRoute('/dashboard/flags')({
  loaderDeps: ({ search }) => ({ vin: (search as { vin?: string }).vin }),
  loader: ({ deps }) => getAnomalies({ data: { vin: deps.vin } }),
  component: FlagsPage,
})

const TYPE_LABEL: Record<string, string> = {
  slow_charge: 'Slow charge',
  efficiency_drop: 'Efficiency drop',
}

function FlagsPage() {
  const { flags } = Route.useLoaderData()
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
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const isWarning = flag.severity === 'warning'

  async function onDismiss() {
    setBusy(true)
    try {
      await dismissAnomaly({ data: { id: flag.id } })
      await router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="island-shell flex items-start justify-between gap-4 rounded-2xl p-4">
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{
              background: isWarning ? 'rgba(180,83,9,0.16)' : 'rgba(79,184,178,0.18)',
              color: 'var(--sea-ink)',
            }}
          >
            {TYPE_LABEL[flag.type] ?? flag.type}
          </span>
          <span className="text-xs text-[var(--sea-ink-soft)]">{dateTime(flag.created_at)}</span>
        </div>
        <p className="m-0 text-sm text-[var(--sea-ink)]">{flag.message}</p>
      </div>
      {!dismissed && (
        <button
          onClick={onDismiss}
          disabled={busy}
          className="shrink-0 rounded-full border border-[var(--line)] bg-white/50 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5 disabled:opacity-60"
        >
          {busy ? '…' : 'Dismiss'}
        </button>
      )}
    </article>
  )
}
