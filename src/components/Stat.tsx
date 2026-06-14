/** Small presentational helpers shared across dashboard pages. */

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <article className="island-shell rounded-2xl p-4">
      <p className="island-kicker mb-1 text-xs">{label}</p>
      <p className="m-0 text-2xl font-bold tracking-tight text-[var(--sea-ink)]">{value}</p>
      {sub && <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">{sub}</p>}
    </article>
  )
}

export function money(amount: number | null | undefined, currency: string | null): string {
  if (amount == null) return '—'
  const c = currency || 'USD'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${c}`
  }
}

export function miles(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n).toLocaleString()} mi`
}

export function kwh(n: number | null | undefined): string {
  return n == null ? '—' : `${(Math.round(n * 100) / 100).toLocaleString()} kWh`
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

/** Coarse relative time ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="island-shell rounded-2xl p-8 text-center text-sm text-[var(--sea-ink-soft)]">
      {children}
    </div>
  )
}

export function SourceBadge({ source, costSource }: { source: string; costSource: string }) {
  const isBilled = costSource === 'tesla_billed'
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        background: source === 'supercharger' ? 'rgba(79,184,178,0.18)' : 'rgba(47,106,74,0.14)',
        color: 'var(--sea-ink)',
      }}
      title={isBilled ? 'Cost billed by Tesla (authoritative)' : 'Cost estimated from your electricity rate'}
    >
      {source === 'supercharger' ? 'Supercharger' : source === 'home' ? 'Home' : 'Other'}
      {isBilled ? ' · billed' : ' · est.'}
    </span>
  )
}
