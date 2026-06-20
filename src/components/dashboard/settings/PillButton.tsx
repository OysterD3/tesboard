import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'

/** Shared grey pill button (the repeated rounded-full secondary control in Settings). */
export function PillButton({
  children,
  onClick,
  busy = false,
  type = 'button',
  className,
}: {
  children: ReactNode
  onClick?: () => void
  busy?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy}
      className={cn(
        'text-[13px] font-semibold text-foreground bg-secondary border border-border rounded-full px-3.5 py-2',
        busy ? 'cursor-default opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Shared input styling matching the former inputStyle const. */
export const inputClass =
  'w-full rounded-xl border border-border bg-secondary px-3 py-2.5 text-foreground outline-none font-[inherit] text-sm'

/** Labelled form field (label above an input/control). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="text-xs font-semibold text-muted-foreground">
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  )
}
