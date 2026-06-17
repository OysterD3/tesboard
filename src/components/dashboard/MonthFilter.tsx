import type { MonthOption } from '../../lib/month-group'

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

/**
 * Horizontal scrollable month chips ("All", "Jun 2026", …) for the drive/charge
 * lists. Renders nothing when there's at most one month of data (no point). The
 * active chip is filled with the section `color`.
 */
export function MonthFilter({
  months,
  value,
  onChange,
  color,
  isDark,
}: {
  months: MonthOption[]
  value: string
  onChange: (key: string) => void
  color: string
  isDark?: boolean
}) {
  if (months.length <= 2) return null // just "All" + one month — nothing to filter
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        overflowX: 'auto',
        paddingBottom: 2,
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {months.map((m) => {
        const active = m.key === value
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onChange(m.key)}
            style={{
              flex: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              padding: '7px 14px',
              borderRadius: 30,
              whiteSpace: 'nowrap',
              transition: 'background 120ms, color 120ms',
              color: active ? '#fff' : TX,
              background: active ? color : isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
              border: `1px solid ${active ? color : 'var(--border,rgba(0,0,0,0.08))'}`,
            }}
          >
            {m.label}
            {m.key !== 'all' && (
              <span style={{ marginLeft: 6, opacity: 0.7, color: active ? '#fff' : TD }}>{m.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Inline month section header rendered between groups in the virtualized list. */
export function MonthHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '8px 2px 4px',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{count}</span>
    </div>
  )
}
