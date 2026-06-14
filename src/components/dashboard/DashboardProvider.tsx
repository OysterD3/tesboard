import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_UNITS,
  type DistUnit,
  type EffUnit,
  type PresUnit,
  type TempUnit,
  type Units,
} from '../../lib/units'
import { DEFAULT_ACCENT, type ThemeName } from './theme'

interface DashboardState {
  theme: ThemeName
  units: Units
  accent: string
  toggleTheme: () => void
  setTheme: (theme: ThemeName) => void
  setUnit: <K extends keyof Units>(key: K, value: Units[K]) => void
  setAccent: (hex: string) => void
}

const Ctx = createContext<DashboardState | null>(null)

const UNITS_KEY = 'evd:units'
const ACCENT_KEY = 'evd:accent'

function readUnits(): Units {
  try {
    const raw = window.localStorage.getItem(UNITS_KEY)
    if (!raw) return DEFAULT_UNITS
    const p = JSON.parse(raw) as Partial<Units>
    return {
      dist: (p.dist === 'km' ? 'km' : 'mi') as DistUnit,
      temp: (p.temp === 'c' ? 'c' : 'f') as TempUnit,
      pres: (p.pres === 'bar' ? 'bar' : 'psi') as PresUnit,
      eff: (p.eff === 'whkm' ? 'whkm' : 'mi') as EffUnit,
    }
  } catch {
    return DEFAULT_UNITS
  }
}

/** Resolve the currently-applied global theme (set by the root init script). */
function readGlobalTheme(): ThemeName {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** Write the dashboard theme back into the app-wide theme system so the choice
 *  is shared with the rest of the site (and survives reloads). */
function applyGlobalTheme(theme: ThemeName) {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(theme)
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
  try {
    window.localStorage.setItem('theme', theme)
  } catch {
    /* ignore */
  }
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  // SSR + first client render use the defaults so hydration matches; the effect
  // below then syncs to whatever the user previously chose.
  const [theme, setTheme] = useState<ThemeName>('light')
  const [units, setUnits] = useState<Units>(DEFAULT_UNITS)
  const [accent, setAccentState] = useState<string>(DEFAULT_ACCENT)

  useEffect(() => {
    setTheme(readGlobalTheme())
    setUnits(readUnits())
    try {
      const a = window.localStorage.getItem(ACCENT_KEY)
      if (a) setAccentState(a)
    } catch {
      /* ignore */
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: ThemeName = t === 'dark' ? 'light' : 'dark'
      applyGlobalTheme(next)
      return next
    })
  }, [])

  const setThemeExplicit = useCallback((next: ThemeName) => {
    setTheme(next)
    applyGlobalTheme(next)
  }, [])

  const setUnit = useCallback<DashboardState['setUnit']>((key, value) => {
    setUnits((u) => {
      const next = { ...u, [key]: value }
      try {
        window.localStorage.setItem(UNITS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const setAccent = useCallback((hex: string) => {
    setAccentState(hex)
    try {
      window.localStorage.setItem(ACCENT_KEY, hex)
    } catch {
      /* ignore */
    }
  }, [])

  const value = useMemo(
    () => ({ theme, units, accent, toggleTheme, setTheme: setThemeExplicit, setUnit, setAccent }),
    [theme, units, accent, toggleTheme, setThemeExplicit, setUnit, setAccent],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDash(): DashboardState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDash must be used within <DashboardProvider>')
  return ctx
}
