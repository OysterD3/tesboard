/**
 * Visual design tokens for the premium EV dashboard (ported from the Claude
 * Design "EV Dashboard.dc.html" handoff). The dashboard is themed entirely with
 * CSS custom properties applied inline to its root element — keeping it scoped
 * to the dashboard shell so it doesn't collide with the marketing site's theme.
 */
import type { CSSProperties } from 'react'

export type ThemeName = 'light' | 'dark'

/** Per-section semantic colors — each tab carries its own accent. */
export const SECTION = {
  drives: '#6366f1',
  charging: '#f59e0b',
  insights: '#14b8a6',
  analytics: '#0ea5e9',
  settings: '#8b5cf6',
} as const

/** Accent swatches offered in Settings (Overview + active states recolor live). */
export const ACCENT_PALETTE = [
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f59e0b',
  '#10b981',
  '#14b8a6',
] as const

export const DEFAULT_ACCENT = '#3b82f6'

export function round(n: number, d = 0): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

/** hex (#rgb or #rrggbb) → rgba() string at the given alpha. */
export function hexToRgba(hex: string, a: number): string {
  let h = (hex || DEFAULT_ACCENT).replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** The full set of CSS variables for a theme + accent, as an inline style. */
export function themeVars(theme: ThemeName, accent: string): CSSProperties {
  const ac = accent || DEFAULT_ACCENT
  if (theme === 'dark') {
    return {
      '--bg': '#0b0b0c',
      '--card': '#161618',
      '--border': 'rgba(255,255,255,0.09)',
      '--tx': '#f5f5f7',
      '--td': '#86868b',
      '--ac': ac,
      '--track': '#1d1d20',
      '--seg-active': '#3a3a3d',
      '--ring-track': '#2a2a2e',
      '--nav-bg': 'rgba(22,22,24,0.78)',
      '--map-land': '#1a1a1c',
      '--map-road': '#2a2a2e',
      '--map-park': '#16231b',
      '--map-water': '#13202c',
      '--shadow': '0 1px 2px rgba(0,0,0,0.5)',
    } as CSSProperties
  }
  return {
    '--bg': '#f5f5f7',
    '--card': '#ffffff',
    '--border': 'rgba(0,0,0,0.07)',
    '--tx': '#1d1d1f',
    '--td': '#86868b',
    '--ac': ac,
    '--track': '#f0f0f3',
    '--seg-active': '#ffffff',
    '--ring-track': '#ececef',
    '--nav-bg': 'rgba(255,255,255,0.82)',
    '--map-land': '#e9e9ec',
    '--map-road': '#ffffff',
    '--map-park': '#dfeede',
    '--map-water': '#dbe7f5',
    '--shadow': '0 1px 2px rgba(17,17,19,0.04), 0 8px 24px rgba(17,17,19,0.05)',
  } as CSSProperties
}

/** Lucide-ish single-path icons used across the dashboard (24×24 viewBox). */
export const ICON = {
  overview: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  drives:
    'M12 21s6.5-5.9 6.5-11.5a6.5 6.5 0 1 0-13 0C5.5 15.1 12 21 12 21z M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  charging: 'M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z',
  insights: 'M3 3v18h18 M7 14v4 M12 9v9 M17 12v6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 5 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  calendar:
    'M3 9h18 M7 3v4 M17 3v4 M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  road: 'M4 19l3-14 M20 19l-3-14 M12 5v3 M12 12v3 M12 19v0',
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z M2 21c0-3 1.85-5.36 5.08-6',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  chevron: 'M9 6l6 6-6 6',
  check: 'M20 6L9 17l-5-5',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v3 M12 20v3 M4.2 4.2l2.1 2.1 M17.7 17.7l2.1 2.1 M1 12h3 M20 12h3 M4.2 19.8l2.1-2.1 M17.7 6.3l2.1-2.1',
  moon: 'M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z',
  sparkles:
    'M12 2v6 M5.6 5.6l4.2 4.2 M2 12h6 M5.6 18.4l4.2-4.2 M12 22v-6 M18.4 18.4l-4.2-4.2 M22 12h-6 M18.4 5.6l-4.2 4.2',
  analytics: 'M3 3v18h18 M7 14v4 M12 9v9 M17 12v6',
  battery:
    'M3 8h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M22 11v2 M6 11v2',
  gauge: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M13.4 10.6 19 5 M3 12a9 9 0 0 1 18 0',
  thermometer: 'M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0z',
  pin: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  clock: 'M12 7v5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  mountain: 'M8 3l4 8 5-5 5 15H2L8 3z',
  dollar: 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
} as const
