/**
 * Router pending fallback — also the content prerendered into the SPA shell
 * (/_shell.html) shown until the client renders. Kept theme-agnostic: it sits on
 * the global island background (styles.css body), so it uses the sea-ink vars +
 * currentColor rather than the dashboard runtime-theme bridge classes (those only
 * resolve inside the dashboard root). The THEME_INIT_SCRIPT has already set the
 * .dark class by the time this paints, so the vars resolve correctly in both modes.
 */
export function PendingScreen() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center text-[var(--sea-ink-soft)]">
      <span
        className="inline-block w-7 h-7 rounded-full border-2 border-current border-t-transparent animate-spin"
        aria-label="Loading"
        role="status"
      />
    </div>
  )
}
