import { RANGE_CHIPS, clampCustom, toYmdUtc, type RangeKey, type RangeState } from '../../lib/range-filter'

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const DAY_MS = 86_400_000

/**
 * Horizontal scrollable date-range chips shared by every dated view (Drives /
 * Charging / Idles → History, Map, Insights). Mirrors the MonthFilter chip style.
 * "Custom" reveals a start/end date pair. "Since last charge" is hidden when the
 * account has no charges (no anchor). `nowMs` is the server-anchored "now" from
 * the dashboard loader so the default window resolves identically on SSR and the
 * client (no hydration flicker).
 */
export function RangeFilter({
  state,
  onChange,
  accent,
  isDark,
  nowMs,
  lastChargeMs = null,
}: {
  state: RangeState
  onChange: (s: RangeState) => void
  accent: string
  isDark: boolean
  nowMs: number
  lastChargeMs?: number | null
}) {
  const todayYmd = toYmdUtc(nowMs)
  const chips = RANGE_CHIPS.filter((c) => c.key !== 'sinceLastCharge' || lastChargeMs != null)
  // A persisted "since last charge" with no charge resolves to all-time (see
  // resolveRange) and its chip is hidden — highlight "All time" so the bar still
  // reflects the window that's actually applied, rather than nothing.
  const effectiveKey = state.key === 'sinceLastCharge' && lastChargeMs == null ? 'all' : state.key

  function selectKey(key: RangeKey) {
    if (key === 'custom') {
      // Seed a valid last-7-days window so the page never goes blank on entry.
      onChange({
        key: 'custom',
        customFrom: state.customFrom ?? toYmdUtc(nowMs - 7 * DAY_MS),
        customTo: state.customTo ?? todayYmd,
      })
    } else {
      onChange({ key })
    }
  }

  function applyCustom(from: string, to: string) {
    const c = clampCustom(from, to)
    onChange({ key: 'custom', customFrom: c.from, customTo: c.to })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        {chips.map((c) => {
          const active = c.key === effectiveKey
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={active}
              onClick={() => selectKey(c.key)}
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
                background: active ? accent : isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
                border: `1px solid ${active ? accent : 'var(--border,rgba(0,0,0,0.08))'}`,
              }}
            >
              {c.label}
            </button>
          )
        })}
      </div>

      {state.key === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateInput
            label="Start date"
            value={state.customFrom ?? ''}
            max={todayYmd}
            isDark={isDark}
            onChange={(v) => applyCustom(v, state.customTo ?? todayYmd)}
          />
          <span aria-hidden="true" style={{ color: TD, fontSize: 13, fontWeight: 600, flex: 'none' }}>–</span>
          <DateInput
            label="End date"
            value={state.customTo ?? ''}
            min={state.customFrom ?? undefined}
            max={todayYmd}
            isDark={isDark}
            onChange={(v) => applyCustom(state.customFrom ?? v, v)}
          />
        </div>
      )}
    </div>
  )
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
  isDark,
}: {
  label: string
  value: string
  min?: string
  max?: string
  onChange: (v: string) => void
  isDark: boolean
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      style={{
        flex: 1,
        minWidth: 0,
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        color: TX,
        background: isDark ? 'rgba(255,255,255,0.06)' : 'var(--card,#fff)',
        border: '1px solid var(--border,rgba(0,0,0,0.12))',
        borderRadius: 10,
        padding: '8px 10px',
        colorScheme: isDark ? 'dark' : 'light',
      }}
    />
  )
}
