import { CalendarIcon } from 'lucide-react'
import {
  RANGE_CHIPS,
  clampCustom,
  rangeLabel,
  toYmdUtc,
  type RangeKey,
  type RangeState,
} from '../../lib/range-filter'
import { themeVars } from './theme'
import { cn } from '../../lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select'

const DAY_MS = 86_400_000

/**
 * Date-range filter shared by every dated view (Drives / Charging / Idles →
 * History, Map, Insights): a compact shadcn Select dropdown. Picking "Custom"
 * reveals a start/end date pair; "Since last charge" is hidden when the account
 * has no charges (no anchor). `nowMs` is the server-anchored "now" from the
 * dashboard loader so the default window resolves identically on SSR and the
 * client (no hydration flicker).
 *
 * The dropdown content is portaled to <body> by Radix, which lives OUTSIDE the
 * dashboard root that carries the runtime theme vars — so we stamp `themeVars()`
 * inline on the content (and bias `--ac` to the section accent) to keep the
 * popover self-themed in light AND dark mode.
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
  // Selections that resolve to all-time but aren't literally "all": "since last
  // charge" with no charge anchor (option hidden), or a custom range missing a
  // bound (only via corrupted/legacy storage). Surface them as "All time" so the
  // control reflects the window actually applied (resolveRange) rather than a
  // hidden option or a "Custom" label over all-time data.
  const incompleteCustom = state.key === 'custom' && (!state.customFrom || !state.customTo)
  const fellBackToAll = (state.key === 'sinceLastCharge' && lastChargeMs == null) || incompleteCustom
  const effectiveKey: RangeKey = fellBackToAll ? 'all' : state.key
  const triggerLabel = fellBackToAll ? 'All time' : rangeLabel(state)
  const contentVars = themeVars(isDark ? 'dark' : 'light', accent)

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
    <div className="flex flex-col gap-2.5 items-start">
      <Select value={effectiveKey} onValueChange={(v) => selectKey(v as RangeKey)}>
        <SelectTrigger
          aria-label="Date range"
          // bg-card (folded into cn, last-wins) beats shadcn's stray
          // `dark:bg-input/30` (the app themes via CSS vars + a `.dark` class, not
          // Tailwind's OS-pref `dark:` variant) so the pill stays a solid, readable
          // card — including floated over the map.
          className={cn('rounded-full px-3.5 text-[13px] font-semibold shadow-sm bg-card')}
        >
          <span className="flex items-center gap-[7px] min-w-0">
            <CalendarIcon style={{ color: accent }} aria-hidden="true" />
            <span className="text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
              {triggerLabel}
            </span>
          </span>
        </SelectTrigger>
        <SelectContent style={contentVars} className="font-sans">
          {chips.map((c) => (
            <SelectItem
              key={c.key}
              value={c.key}
              className="text-[13px] font-medium"
              style={c.key === effectiveKey ? { color: accent, fontWeight: 600 } : undefined}
            >
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {state.key === 'custom' && !incompleteCustom && (
        <div className="flex items-center gap-2 max-w-full">
          <DateInput
            label="Start date"
            value={state.customFrom ?? ''}
            max={todayYmd}
            isDark={isDark}
            onChange={(v) => applyCustom(v, state.customTo ?? todayYmd)}
          />
          <span aria-hidden="true" className="text-muted-foreground text-[13px] font-semibold flex-none">–</span>
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
      className={cn(
        'flex-1 min-w-0 font-[inherit] text-[13px] font-semibold text-foreground border border-border rounded-[10px] px-2.5 py-2',
        !isDark && 'bg-card',
      )}
      // The dark surface tint + colorScheme stay inline: the app themes via a
      // `.dark` class + CSS vars, not Tailwind's OS-pref `dark:` variant.
      style={{
        background: isDark ? 'rgba(255,255,255,0.06)' : undefined,
        colorScheme: isDark ? 'dark' : 'light',
      }}
    />
  )
}
