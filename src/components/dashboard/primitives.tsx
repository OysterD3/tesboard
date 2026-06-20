/**
 * Shared visual primitives for the EV dashboard, ported from the Claude Design
 * handoff. Everything is themed through the CSS variables set on the dashboard
 * root (see theme.ts / DashboardProvider), so these stay theme-agnostic.
 *
 * This file is a BARREL: the implementations live in sibling modules so each
 * stays small (< 300 LoC). The import path
 * `components/dashboard/primitives` is stable for all existing consumers.
 *   - primitives-surfaces  → Card, Icon, EmptyCard, ViewTitle, SectionLabel,
 *                            DashCardButton, BackHeader, AccentChip/IconChip, BigStat
 *   - primitives-charts    → ChartTooltip, HoverBars, BatteryRing, BatteryGlyph
 *   - primitives-controls  → Segmented
 */
export {
  Card,
  Icon,
  EmptyCard,
  ViewTitle,
  SectionLabel,
  DashCardButton,
  BackHeader,
  AccentChip,
  IconChip,
  BigStat,
} from './primitives-surfaces'

export { ChartTooltip, HoverBars, BatteryRing, BatteryGlyph, type HoverBar } from './primitives-charts'

export { Segmented, type SegOption } from './primitives-controls'
