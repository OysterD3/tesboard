/**
 * Leaflet `divIcon` HTML builders for LifetimeMap. These strings are injected into
 * Leaflet's own panes (OUTSIDE React's DOM tree), so they CANNOT use Tailwind
 * classes — Tailwind's JIT never sees them and they're not in the themed React
 * subtree. They stay as inline-styled raw HTML on purpose.
 */

/** Numbered cluster bubble (count = how many markers it merges). */
export function clusterHtml(n: number, size: number, color: string): string {
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;font-family:'Geist',system-ui,sans-serif;">${n}</div>`
}

/** A single point dot (a charge place, or a drive start/end endpoint). */
export function dotHtml(color: string): string {
  return `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`
}

/** Cluster-bubble diameter scales with the merged-marker count. */
export function clusterSizeFor(n: number): number {
  return n < 10 ? 34 : n < 100 ? 40 : 46
}
