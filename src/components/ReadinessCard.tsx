/** Departure-readiness hero card. Honest about staleness — a sleeping car yields
 *  no new reading, so the number can legitimately be hours old. */
import type { DepartureReadiness, Staleness } from '../functions/readiness.functions'
import { dateTime, miles, relativeTime } from './Stat'
import { useDisplayTz } from '../lib/use-hydrated'

const STALE_COLOR: Record<Staleness, string> = {
  fresh: 'var(--lagoon-deep)',
  recent: 'var(--sea-ink-soft)',
  stale: '#b45309', // amber-700
  very_stale: '#b91c1c', // red-700
  none: 'var(--sea-ink-soft)',
}

function recommendationText(r: DepartureReadiness): { text: string; tone: 'good' | 'warn' | 'muted' } {
  switch (r.recommendation) {
    case 'charging':
      return { text: 'Charging now', tone: 'good' }
    case 'ok':
      return { text: `Ready for tomorrow — ${r.soc_pct}% / ${miles(r.est_range_mi)}`, tone: 'good' }
    case 'consider_charging':
      return { text: `Consider charging before tomorrow — ${r.soc_pct}%`, tone: 'warn' }
    default:
      return { text: 'No recent reading', tone: 'muted' }
  }
}

export function ReadinessCard({ r }: { r: DepartureReadiness }) {
  const tz = useDisplayTz()
  if (r.as_of == null) {
    return (
      <article className="island-shell rounded-2xl p-5">
        <p className="island-kicker mb-1 text-xs">{r.display_name ?? r.vin}</p>
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
          No readings yet — the poller will populate this within a few minutes of linking.
        </p>
      </article>
    )
  }

  const rec = recommendationText(r)
  const recBg =
    rec.tone === 'good'
      ? 'rgba(47,106,74,0.14)'
      : rec.tone === 'warn'
        ? 'rgba(180,83,9,0.14)'
        : 'rgba(120,120,120,0.12)'
  const stale = r.staleness === 'stale' || r.staleness === 'very_stale'

  return (
    <article className="island-shell rounded-2xl p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="island-kicker m-0 text-xs">{r.display_name ?? r.vin}</p>
        <span
          className="text-xs font-semibold"
          style={{ color: STALE_COLOR[r.staleness] }}
          title={`As of ${dateTime(r.as_of, tz)}`}
        >
          Updated {relativeTime(r.as_of)}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="m-0 text-4xl font-bold tracking-tight text-[var(--sea-ink)]">
            {r.soc_pct != null ? `${r.soc_pct}%` : '—'}
          </p>
          <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">Battery</p>
        </div>
        <div>
          <p className="m-0 text-2xl font-semibold text-[var(--sea-ink)]">{miles(r.est_range_mi)}</p>
          <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">Est. range</p>
        </div>
        <div>
          <p className="m-0 text-base font-semibold text-[var(--sea-ink)]">
            {r.charging_state ?? '—'}
          </p>
          <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">Charging state</p>
        </div>
      </div>

      <div
        className="mt-4 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--sea-ink)]"
        style={{ background: recBg }}
      >
        {rec.text}
      </div>

      {stale && (
        <p className="m-0 mt-2 text-xs text-[var(--sea-ink-soft)]">
          Car may be asleep — this is the last reading we have. This app never wakes the car.
        </p>
      )}
    </article>
  )
}
