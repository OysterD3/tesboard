import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card, EmptyCard, HoverBars, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { buildInsights } from '../../lib/dashboard-vm'
import { distUnit, fmtDay, fmtDist } from '../../lib/units'
import {
  getPhantomCauses,
  backfillStandbyFlags,
  type PhantomCausesPayload,
} from '../../functions/phantom-causes.functions'
import { getPhantomDrain } from '../../functions/insights.functions'
import type { PhantomCause } from '../../lib/analytics-vm'

export const Route = createFileRoute('/dashboard/idles_/insights')({
  // phantom-drain loaded lazily here (not in the every-route parent loader) to
  // keep SSR CPU low; the rest reads the shared parent loader data.
  loaderDeps: ({ search }) => ({ vin: (search as { vin?: string }).vin }),
  loader: ({ deps }) => getPhantomDrain({ data: { vin: deps.vin } }),
  component: IdlesInsightsPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.idles

/**
 * Idles → Insights. Standby (phantom) range loss while parked & unplugged, plus a
 * cause breakdown. Phantom drain is fetched by this route's own loader; the cause
 * card fetches on its own and degrades silently if its flags aren't backfilled.
 */
function IdlesInsightsPage() {
  const { drives, charging } = dashApi.useLoaderData()
  const phantom = Route.useLoaderData()
  const { units: u, theme } = useDash()
  const isDark = theme === 'dark'
  const vm = buildInsights(charging, drives, null, phantom)

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Idles</ViewTitle>
        <SectionTabs section="idles" value="insights" accent={COLOR} isDark={isDark} />
      </div>

      {/* Phantom miles (derived from snapshots) */}
      {vm.phantom ? (
        <Card radius={22} style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Standby loss · phantom {distUnit(u)}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: TX }}>{fmtDist(u, vm.phantom.lostKm, 1)}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: TD }}>{distUnit(u)} lost</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Over {vm.phantom.days} days parked · ~{fmtDist(u, vm.phantom.perDayKm, 1)} {distUnit(u)}/day</span>
            </div>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(244,63,94,0.13)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Icon d={ICON.sparkles} size={22} color="#f43f5e" />
            </div>
          </div>
          {vm.phantom.series.length >= 2 && (
            <div style={{ marginTop: 18 }}>
              {(() => {
                const series = vm.phantom.series.slice(-30)
                const max = Math.max(...series.map((d) => d.lostKm), 0.1)
                return (
                  <HoverBars
                    height={40}
                    color="#f43f5e"
                    opacity={0.55}
                    bars={series.map((d) => ({
                      heightPct: Math.max(6, (d.lostKm / max) * 100),
                      tip: (
                        <>
                          <span style={{ color: '#f43f5e' }}>{fmtDist(u, d.lostKm, 1)} {distUnit(u)}</span>
                          <span style={{ color: TD, fontWeight: 500 }}> · {fmtDay(d.date)}</span>
                        </>
                      ),
                    }))}
                  />
                )
              })()}
              <span style={{ fontSize: 11, fontWeight: 500, color: TD, marginTop: 7, display: 'block' }}>Daily loss · last {Math.min(30, vm.phantom.series.length)} days with drain</span>
            </div>
          )}
        </Card>
      ) : (
        <EmptyCard title="No standby loss measured yet" body="Phantom drain is derived from snapshots taken while parked and unplugged — it appears once enough have accumulated." />
      )}

      {/* Phantom-drain cause attribution (lazy + error-safe) */}
      {vm.phantom && <PhantomCausesCard />}
    </div>
  )
}

const CAUSE_META: Record<PhantomCause, { label: string; color: string }> = {
  sentry: { label: 'Sentry Mode', color: '#f43f5e' },
  climate: { label: 'Climate / preheat', color: '#f59e0b' },
  cold: { label: 'Cold ambient', color: '#0a84ff' },
  awake: { label: 'Awake (idle)', color: '#8b5cf6' },
  asleep: { label: 'Asleep (baseline)', color: '#86868b' },
}

/**
 * Standby-loss cause breakdown. Fetches on its own (off the main loader) and
 * degrades silently if the cause-flag migration hasn't been applied yet, so it
 * can never block the rest of the view.
 */
function PhantomCausesCard() {
  const { units: u } = useDash()
  const fetchCauses = useServerFn(getPhantomCauses)
  const runBackfill = useServerFn(backfillStandbyFlags)
  const [data, setData] = useState<PhantomCausesPayload | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchCauses({ data: {} })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
    return () => {
      cancelled = true
    }
  }, [fetchCauses])

  async function backfill() {
    if (busy) return
    setBusy(true)
    try {
      for (let i = 0; i < 40; i++) {
        const r = await runBackfill()
        if (!r.available || r.remaining === 0 || r.updated === 0) break
      }
      const fresh = await fetchCauses({ data: {} })
      setData(fresh)
    } catch {
      /* leave existing data */
    } finally {
      setBusy(false)
    }
  }

  // Nothing to show until we have a confirmed-available result with data.
  if (!data || !data.available || !data.hasData) return null

  return (
    <Card radius={22} style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>What drained it · last 30 days</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: TD }}>{fmtDist(u, data.totalMi * 1.60934, 1)} {distUnit(u)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginTop: 16 }}>
        {data.slices.map((s) => {
          const meta = CAUSE_META[s.cause]
          return (
            <div key={s.cause}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: TX }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
                  {meta.label}
                </span>
                <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>{fmtDist(u, s.lostMi * 1.60934, 1)} {distUnit(u)} · {s.pct}%</span>
              </div>
              <div style={{ height: 8, borderRadius: 5, background: 'var(--track,#f0f0f3)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(2, s.pct)}%`, height: '100%', background: meta.color }} />
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: TD, lineHeight: 1.4 }}>
          Attributed by what was active each interval — a heuristic, not metered.
        </span>
        {data.unattributed > 0 && (
          <button
            type="button"
            onClick={backfill}
            disabled={busy}
            title="Fill cause flags for older snapshots from stored data"
            style={{ flex: 'none', cursor: busy ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, color: busy ? TD : '#f43f5e', background: 'transparent', border: `1px solid ${busy ? 'var(--border,rgba(0,0,0,0.08))' : '#f43f5e'}`, borderRadius: 30, padding: '6px 12px', whiteSpace: 'nowrap' }}
          >
            {busy ? 'Backfilling…' : 'Improve history'}
          </button>
        )}
      </div>
    </Card>
  )
}
