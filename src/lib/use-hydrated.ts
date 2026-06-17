/**
 * Hydration-safe time-zone helper.
 *
 * SSR runs in the Worker runtime (workerd), whose local time zone is UTC, while
 * the browser formats in the visitor's zone. Any `toLocale*` call made during
 * render therefore produces different text on the server vs the client, and React
 * aborts hydration with a text-mismatch error (#418) — e.g. "Today · 10:39 PM"
 * (UTC) vs "Today · 6:39 AM" (UTC+8).
 *
 * The fix: format timestamps in a STABLE zone ('UTC') during SSR and the first
 * client render (so the two match and hydration succeeds), then re-render in the
 * browser's local zone after mount. `useDisplayTz()` returns the zone to pass to
 * the dashboard formatters; `undefined` means "use the runtime's local zone".
 */
import { useEffect, useState } from 'react'

/** false during SSR and the first client render, true after the component mounts. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}

/** 'UTC' until hydrated (matches SSR), then `undefined` = the browser's local zone. */
export function useDisplayTz(): string | undefined {
  return useHydrated() ? undefined : 'UTC'
}
