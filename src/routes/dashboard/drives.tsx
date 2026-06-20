import { createFileRoute, getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { BatteryGlyph, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import type { DriveVM } from '../../lib/dashboard-vm'
import type { Units } from '../../lib/units'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION } from '../../components/dashboard/theme'
import { buildDrives } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth } from '../../lib/month-group'
import { filterByRange, lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'
const COLOR = SECTION.drives

function DrivesPage() {
  const { drives, charging, now } = dashApi.useLoaderData()
  const { units: u, theme, range, setRange } = useDash()
  const isDark = theme === 'dark'
  const navigate = useNavigate()
  const tz = useDisplayTz()

  const nowMs = Date.parse(now)
  const lastChargeMs = useMemo(() => lastChargeMsOf(charging.sessions), [charging.sessions])
  const resolved = useMemo(() => resolveRange(range, nowMs, lastChargeMs), [range, nowMs, lastChargeMs])
  const windowed = useMemo(
    () => buildDrives({ ...drives, drives: filterByRange(drives.drives, resolved) }, tz),
    [drives, resolved, tz],
  )
  const rows = groupByMonth(windowed, (d) => d.id)
  const noneAtAll = drives.drives.length === 0

  function open(id: string) {
    navigate({ to: '/dashboard/drives/$driveId', params: { driveId: id }, search: (prev) => prev })
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <ViewTitle>Drives</ViewTitle>
        <SectionTabs section="drives" value="history" accent={COLOR} isDark={isDark} />
      </div>

      <RangeFilter state={range} onChange={setRange} accent={COLOR} isDark={isDark} nowMs={nowMs} lastChargeMs={lastChargeMs} />

      {rows.length === 0 ? (
        <EmptyCard
          title={noneAtAll ? 'No drives recorded yet' : 'No drives in this range'}
          body={
            noneAtAll
              ? 'Drives are built from polled snapshots (the Fleet API has no trip endpoint), so they start accruing once the poller is running and you take a drive.'
              : 'Try a wider date range to see more drives.'
          }
        />
      ) : (
        <VirtualList
          items={rows}
          getKey={(r) => r.key}
          estimateRowHeight={148}
          renderRow={(r) => {
            if (r.kind === 'header') return <MonthHeader label={r.label} count={r.count} />
            return <DriveCard d={r.item} u={u} onClick={() => open(r.item.id)} />
          }}
        />
      )}
    </div>
  )
}

/**
 * A drive history card in the Tessie "From → To" shape: a start endpoint (muted
 * pin) and an end endpoint (accent pin) joined by a dotted rail, each line a
 * place + state-of-charge + timestamp, then a divider and a distance / duration /
 * efficiency footer. The whole card navigates to the drive detail page.
 */
function DriveCard({ d, u, onClick }: { d: DriveVM; u: Units; onClick: () => void }) {
  const inProgress = d.endStamp == null
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'var(--card,#fff)',
        border: '1px solid var(--border,rgba(0,0,0,0.07))',
        borderRadius: 18,
        padding: '15px 16px',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color .2s ease, background .2s ease',
      }}
    >
      <Endpoint
        accent={TD}
        place={d.startPlace ?? 'Unknown location'}
        battery={d.startBattery}
        stamp={d.startStamp}
        connector
      />
      <Endpoint
        accent={COLOR}
        place={d.endPlace ?? (inProgress ? 'Drive in progress' : 'Unknown location')}
        battery={d.endBattery}
        stamp={d.endStamp}
      />

      <div style={{ borderTop: '1px solid var(--border,rgba(0,0,0,0.07))', margin: '13px 0 0', paddingTop: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 16, rowGap: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: TX }}>
          <Icon d={ICON.road} size={15} color={TD} />
          {fmtDist(u, d.distKm, 1)} {distUnit(u)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: TD }}>
          <Icon d={ICON.clock} size={15} color={TD} />
          {d.durMin} min
        </span>
        {d.effWhKm != null && (
          <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: TD }}>
            {effFromWhKm(u, d.effWhKm)} {effSuffix(u)}
          </span>
        )}
      </div>
    </button>
  )
}

/** One endpoint line of a DriveCard (pin + place + SOC/timestamp), optionally
 *  trailing the dotted rail down to the next endpoint. */
function Endpoint({
  accent,
  place,
  battery,
  stamp,
  connector = false,
}: {
  accent: string
  place: string
  battery: number | null
  stamp: string | null
  connector?: boolean
}) {
  const meta = [battery != null ? `${battery}%` : null, stamp].filter(Boolean) as string[]
  return (
    // Default align-items (stretch) lets the icon column match the (taller) text
    // column's height, so the flex:1 dotted rail spans the full gap to the next
    // pin — the same continuous-rail pattern the drive-detail Endpoint uses.
    <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
      <div style={{ width: 22, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Icon d={ICON.pin} size={20} color={accent} />
        {connector && (
          <span style={{ flex: 1, marginTop: 4, marginBottom: -2, minHeight: 16, borderLeft: '2px dotted var(--border,rgba(0,0,0,0.2))' }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1, paddingBottom: connector ? 16 : 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: TX, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {place}
        </span>
        {meta.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: TD, minWidth: 0, whiteSpace: 'nowrap' }}>
            {battery != null && <span style={{ flex: 'none', display: 'inline-flex' }}><BatteryGlyph pct={battery} color={TD} size={18} /></span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.join(' · ')}</span>
          </span>
        )}
      </div>
    </div>
  )
}
