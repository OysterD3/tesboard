/**
 * Control primitives for the EV dashboard. Currently the iOS-style segmented
 * control (History/Map/Insights, unit pickers, etc.). Static layout/typography
 * map to Tailwind; the per-item accent color and the isDark-branched active
 * box-shadow stay inline (dynamic).
 */
import { cn } from '../../lib/utils'

/** iOS-style segmented control. */
export interface SegOption<T extends string> {
  label: string
  value: T
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accent,
  isDark,
}: {
  options: SegOption<T>[]
  value: T
  onChange: (v: T) => void
  accent: string
  isDark: boolean
}) {
  return (
    <div className="flex gap-0.5 p-0.5 rounded-[11px] bg-secondary">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'border-none cursor-pointer rounded-[9px] px-[13px] py-[7px] font-[inherit] text-[13px] min-w-[46px] text-center transition-colors duration-150',
              active ? 'font-semibold bg-[var(--seg-active,#fff)]' : 'font-medium bg-transparent',
            )}
            style={{
              color: active ? accent : 'var(--td,#86868b)',
              boxShadow: active
                ? isDark
                  ? 'none'
                  : '0 1px 3px rgba(0,0,0,0.12), 0 1px 1px rgba(0,0,0,0.04)'
                : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
