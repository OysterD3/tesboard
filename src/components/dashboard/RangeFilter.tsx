import { Segmented } from './primitives'
import { MAX_CUSTOM_DAYS, clampCustom, toYmdUtc, type RangeKey, type RangeState } from '../../lib/range-filter'

const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const DAY_MS = 86_400_000

const OPTIONS = [
  { label: '7d', value: '7d' as const },
  { label: '30d', value: '30d' as const },
  { label: 'All', value: 'all' as const },
  { label: 'Custom', value: 'custom' as const },
]

/**
 * Date-range control for the Insights pages: a 7d / 30d / All / Custom segmented
 * toggle, plus a start/end date pair when "Custom" is active. Custom spans are
 * clamped to MAX_CUSTOM_DAYS and capped at `nowMs` (no future dates). `nowMs` is
 * the server-anchored "now" from the dashboard loader, so the default window
 * resolves identically on SSR and the client (no hydration flicker).
 */
export function RangeFilter({
  state,
  onChange,
  accent,
  isDark,
  nowMs,
}: {
  state: RangeState
  onChange: (s: RangeState) => void
  accent: string
  isDark: boolean
  nowMs: number
}) {
  const todayYmd = toYmdUtc(nowMs)

  function selectKey(key: RangeKey) {
    if (key === state.key) return
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
      <Segmented options={OPTIONS} value={state.key} onChange={selectKey} accent={accent} isDark={isDark} />

      {state.key === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
          <span style={{ fontSize: 11, fontWeight: 500, color: TD, paddingLeft: 2 }}>
            Up to {MAX_CUSTOM_DAYS} days
          </span>
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
