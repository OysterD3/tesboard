/**
 * Surface primitives for the EV dashboard: the themed Card, the stroked Icon,
 * empty-state + title bits, and the additive shared shells (clickable card row,
 * detail back-header, accent chip, eyebrow label, big-stat block).
 *
 * Everything is themed through the CSS variables set on the dashboard root
 * (see theme.ts / DashboardProvider) — the static surface colors map to the
 * shadcn @theme-inline bridge classes (bg-card / border-border / text-foreground
 * / text-muted-foreground), while per-instance accent colors stay inline.
 */
import { Link } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import { ICON, hexToRgba } from './theme'
import { cn } from '../../lib/utils'

/**
 * Themed card surface. The base bg/border/shadow live in the className default
 * so consumers can append utilities; `radius` (numeric) and any consumer `style`
 * stay inline and win, preserving the prior spread precedence
 * ({...CARD_BASE, borderRadius:radius, ...style}).
 */
export function Card({
  children,
  radius = 20,
  style,
  className,
}: {
  children: ReactNode
  radius?: number
  style?: CSSProperties
  className?: string
}) {
  return (
    <div
      className={cn('bg-card border border-border shadow-[var(--shadow)]', className)}
      style={{ borderRadius: radius, ...style }}
    >
      {children}
    </div>
  )
}

/** A 24×24 stroked icon (multi-subpath `d`). */
export function Icon({
  d,
  size = 20,
  color = 'currentColor',
  fill = 'none',
  stroke = true,
  width = 2,
}: {
  d: string
  size?: number
  color?: string
  fill?: string
  stroke?: boolean
  width?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke ? color : 'none'}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

/** Honest empty-state card shown when there's no live data for a view/panel. */
export function EmptyCard({ title, body }: { title: string; body?: string }) {
  return (
    <Card radius={20} className="px-[22px] py-7 text-center">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {body && <div className="mt-1.5 text-xs font-medium leading-normal text-muted-foreground">{body}</div>}
    </Card>
  )
}

/** Section title used at the top of Drives / Charging / Insights / Settings. */
export function ViewTitle({ children }: { children: ReactNode }) {
  return <span className="text-[22px] font-bold tracking-[-0.02em] text-foreground">{children}</span>
}

/** Eyebrow / section label (13px medium muted). */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[13px] font-medium text-muted-foreground', className)}>{children}</span>
}

/**
 * A full-width clickable card row (the drives/charging history-card shell).
 * Static surface chrome lives in the className; when `active`, the border + bg
 * tint by the per-section `accent` via hexToRgba (kept inline — accent is a
 * fixed section token, not the runtime --ac). Box dimensions match the prior
 * inline shells exactly (rounded-[18px], px-4 py-[15px]) so VirtualList's
 * estimated row heights stay correct.
 */
export function DashCardButton({
  children,
  onClick,
  className,
  active = false,
  accent,
  isDark = false,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  active?: boolean
  accent?: string
  isDark?: boolean
}) {
  const tint =
    active && accent
      ? {
          background: hexToRgba(accent, isDark ? 0.14 : 0.07),
          borderColor: hexToRgba(accent, isDark ? 0.55 : 0.4),
        }
      : undefined
  return (
    <button
      type="button"
      onClick={onClick}
      style={tint}
      className={cn(
        'w-full text-left cursor-pointer bg-card border border-border rounded-[18px] px-4 py-[15px] flex flex-col transition',
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * The detail-page back header: a 40px circular Link back-button (chevron) plus a
 * title (+ optional subtitle) column. `accent` colors the chevron; defaults to
 * the foreground token string.
 */
export function BackHeader({
  to,
  title,
  subtitle,
  accent,
}: {
  to: string
  title: ReactNode
  subtitle?: ReactNode
  accent?: string
}) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <Link
        to={to}
        search={(prev) => prev}
        aria-label="Back"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-border bg-card no-underline"
      >
        <Icon d={ICON.back} size={20} color={accent ?? 'var(--tx,#1d1d1f)'} />
      </Link>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[21px] font-bold tracking-[-0.02em] text-foreground">{title}</span>
        {subtitle != null && <span className="text-[13px] font-medium text-muted-foreground">{subtitle}</span>}
      </div>
    </div>
  )
}

/**
 * A fixed-size rounded, centered-flex accent chip (icon/glyph holder). The
 * `color`-tinted background uses hexToRgba inline (per-instance accent). `round`
 * picks a circle vs the rounded-square list-row chip. Defaults match the drive
 * endpoint pin chip (28px circle).
 */
export function AccentChip({
  size = 28,
  color,
  isDark = false,
  round = true,
  children,
  className,
}: {
  size?: number
  color: string
  isDark?: boolean
  round?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn('flex flex-none items-center justify-center', round ? 'rounded-full' : 'rounded-[11px]', className)}
      style={{ width: size, height: size, background: hexToRgba(color, isDark ? 0.24 : 0.14) }}
    >
      {children}
    </span>
  )
}

/** Alias of AccentChip — the icon-chip name used by the detail-tile audit. */
export const IconChip = AccentChip

/** A value + label stat block (centered). */
export function BigStat({
  value,
  label,
  color,
  className,
}: {
  value: ReactNode
  label: ReactNode
  color?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-1 text-center', className)}>
      <span className="text-base font-bold tracking-[-0.01em] text-foreground" style={color ? { color } : undefined}>
        {value}
      </span>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
    </div>
  )
}
