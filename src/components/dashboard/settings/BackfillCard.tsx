import { useState, type ReactNode } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '../../../lib/utils'
import { Card } from '../primitives'
import { backfillElevation } from '../../../functions/elevation.functions'
import { backfillAddresses } from '../../../functions/geocode.functions'
import { backfillRouteMatch } from '../../../functions/routematch.functions'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface BackfillState {
  running: boolean
  count: number
  remaining: number | null
  done: boolean
  configured: boolean
}

interface StepResult {
  /** Progress signal for pacing/stall detection (work attempted this step). */
  progress: number
  /** Amount to add to the displayed tally; defaults to `progress`. */
  tally?: number
  remaining: number | null
  /** Stop the loop early (e.g. nothing left). */
  stop: boolean
  /** Mapbox-style "not configured" — stop and flag. */
  configured?: boolean
}

interface BackfillConfig {
  maxIterations: number
  /** Pace between productive iterations (ms). */
  pace?: number
  /** Back-off when an iteration makes no progress (ms) and stall budget. */
  stall?: { wait: number; budget: number }
  step: () => Promise<StepResult>
}

/**
 * Shared driver for the elevation / place-name / road-match backfills: loop a
 * throttled server fn until it reports nothing left (or a stall budget runs
 * out), tracking a running tally and final state, then invalidate the dashboard
 * query so the freshly backfilled data shows.
 */
function useBackfill({ maxIterations, pace, stall, step }: BackfillConfig) {
  const queryClient = useQueryClient()
  const [st, setSt] = useState<BackfillState>({
    running: false,
    count: 0,
    remaining: null,
    done: false,
    configured: true,
  })

  async function go() {
    if (st.running) return
    setSt({ running: true, count: 0, remaining: null, done: false, configured: true })
    let count = 0
    let configured = true
    let stalls = 0
    try {
      for (let i = 0; i < maxIterations; i++) {
        const r = await step()
        if (r.configured === false) {
          configured = false
          break
        }
        count += r.tally ?? r.progress
        setSt({ running: true, count, remaining: r.remaining, done: false, configured: true })
        if (r.stop) break
        if (stall) {
          if (r.progress > 0) {
            stalls = 0
            if (pace) await sleep(pace)
          } else {
            // No progress — rate-limited/paused. Back off, then give up after the budget.
            if (++stalls >= stall.budget) break
            await sleep(stall.wait)
          }
        }
      }
    } catch {
      /* finalize below */
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      setSt((s) => ({ ...s, running: false, done: true, configured }))
    }
  }

  return { st, go }
}

/**
 * On-demand backfills for data the 2-minute Fleet poll can't capture: ground
 * elevation (Open-Meteo), reverse-geocoded place names (Nominatim), and
 * road-matched drive routes (Mapbox). Each loops its throttled server fn until
 * nothing's left; they're deliberately off the cron path (external rate limits),
 * so they live here as manual maintenance actions.
 */
export function BackfillCard() {
  return (
    <Card radius={22} className="p-5">
      <span className="text-[15px] font-semibold text-foreground">Backfill</span>
      <p className="mt-1.5 mb-[18px] text-xs font-medium text-muted-foreground leading-[1.5]">
        Fill in data the Fleet API doesn’t include. Each runs against an external service (rate-limited) and is safe to
        re-run; the new data shows up once it finishes.
      </p>
      <div className="flex flex-col gap-[18px]">
        <ElevationBackfill />
        <LocationsBackfill />
        <RoadMatchBackfill />
      </div>
    </Card>
  )
}

function BackfillRow({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs font-medium text-muted-foreground leading-[1.4]">{sub}</span>
      </div>
      {children}
    </div>
  )
}

function BackfillButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'flex-none text-[13px] font-semibold bg-secondary border border-border rounded-full px-3.5 py-2 whitespace-nowrap',
        busy ? 'text-muted-foreground cursor-default opacity-70' : 'text-foreground cursor-pointer',
      )}
    >
      {label}
    </button>
  )
}

/** Look up ground elevation for GPS points the Fleet API didn't include (Open-Meteo). */
function ElevationBackfill() {
  const run = useServerFn(backfillElevation)
  const { st, go } = useBackfill({
    maxIterations: 80,
    step: async () => {
      const r = await run()
      return { progress: r.filled, remaining: r.remaining, stop: r.filled === 0 || r.remaining === 0 }
    },
  })

  const label = st.running
    ? `Filling… ${st.count}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
    : st.done
      ? st.remaining
        ? `Filled ${st.count} · ${st.remaining} left`
        : `Filled ${st.count}`
      : 'Fill elevation'

  return (
    <BackfillRow title="Elevation" sub="Ground elevation for stored GPS points (Open-Meteo).">
      <BackfillButton busy={st.running} onClick={go} label={label} />
    </BackfillRow>
  )
}

/** Reverse-geocode drives/charges that only show a time into street names (Nominatim). */
function LocationsBackfill() {
  const run = useServerFn(backfillAddresses)
  const { st, go } = useBackfill({
    maxIterations: 80,
    step: async () => {
      const r = await run()
      return { progress: r.linked, remaining: r.remaining, stop: r.linked === 0 || r.remaining === 0 }
    },
  })

  const label = st.running
    ? `Resolving… ${st.count}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
    : st.done
      ? st.remaining
        ? `Named ${st.count} · ${st.remaining} left`
        : `Named ${st.count}`
      : 'Resolve names'

  return (
    <BackfillRow title="Place names" sub="Reverse-geocode drives & charges that only show a time (Nominatim).">
      <BackfillButton busy={st.running} onClick={go} label={label} />
    </BackfillRow>
  )
}

/** Road-match each drive's GPS to the street network via Mapbox (cached; needs MAPBOX_TOKEN). */
function RoadMatchBackfill() {
  const run = useServerFn(backfillRouteMatch)
  const { st, go } = useBackfill({
    maxIterations: 500,
    pace: 400, // pace well under Mapbox's 300 req/min
    stall: { wait: 8000, budget: 6 },
    step: async () => {
      const r = await run()
      if (!r.configured) return { progress: 0, remaining: null, stop: true, configured: false }
      // progress (matched+failed) drives pacing/stall; tally counts only matched.
      return { progress: r.matched + r.failed, tally: r.matched, remaining: r.remaining, stop: r.remaining === 0, configured: true }
    },
  })

  const label = !st.configured
    ? 'Set MAPBOX_TOKEN'
    : st.running
      ? `Snapping… ${st.count}${st.remaining != null ? ` · ${st.remaining} left` : ''}`
      : st.done
        ? st.remaining
          ? `Snapped ${st.count} · ${st.remaining} left`
          : `Snapped ${st.count}`
        : 'Snap to roads'

  return (
    <BackfillRow title="Road matching" sub="Snap each drive's GPS to roads so routes draw on the street network (Mapbox; needs MAPBOX_TOKEN).">
      <BackfillButton busy={st.running} onClick={go} label={label} />
    </BackfillRow>
  )
}
