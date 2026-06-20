/** Inline month section header rendered between groups in the virtualized list. */
export function MonthHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between px-0.5 pt-2 pb-1">
      <span className="text-[13px] font-bold tracking-[-0.01em] text-foreground">{label}</span>
      <span className="text-xs font-medium text-muted-foreground">{count}</span>
    </div>
  )
}
