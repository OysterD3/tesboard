import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useDashboardData } from '../../lib/queries'
import { BatteryGlyph, DashCardButton, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { SectionTabs } from '../../components/dashboard/SectionTabs'
import { RangeFilter } from '../../components/dashboard/RangeFilter'
import type { DriveVM } from '../../lib/dashboard-vm'
import type { Units } from '../../lib/units'
import { VirtualList } from '../../components/dashboard/VirtualList'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON, SECTION, THEME } from '../../components/dashboard/theme'
import { buildDrives } from '../../lib/dashboard-vm'
import { useDisplayTz } from '../../lib/use-hydrated'
import { MonthHeader } from '../../components/dashboard/MonthFilter'
import { groupByMonth } from '../../lib/month-group'
import { filterByRange, lastChargeMsOf, resolveRange } from '../../lib/range-filter'
import { distUnit, effFromWhKm, effSuffix, fmtDist } from '../../lib/units'

export const Route = createFileRoute('/dashboard/drives')({
  component: DrivesPage,
})

const COLOR = SECTION.drives

function DrivesPage() {
  const { drives, charging, now } = useDashboardData()
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
    <div className="evd-view flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2.5 flex-wrap">
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
    <DashCardButton onClick={onClick}>
      <Endpoint
        accent={THEME.td}
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

      <div className="border-t border-border mt-[13px] pt-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-[13px] font-bold tracking-[-0.01em] text-foreground">
          <Icon d={ICON.road} size={15} color={THEME.td} />
          {fmtDist(u, d.distKm, 1)} {distUnit(u)}
        </span>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
          <Icon d={ICON.clock} size={15} color={THEME.td} />
          {d.durMin} min
        </span>
        {d.effWhKm != null && (
          <span className="ml-auto text-[12.5px] font-semibold text-muted-foreground">
            {effFromWhKm(u, d.effWhKm)} {effSuffix(u)}
          </span>
        )}
      </div>
    </DashCardButton>
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
    <div className="flex gap-3 min-w-0">
      <div className="w-[22px] flex-none flex flex-col items-center">
        <Icon d={ICON.pin} size={20} color={accent} />
        {connector && (
          <span className="flex-1 mt-1 -mb-0.5 min-h-4 border-l-2 border-dotted border-border" />
        )}
      </div>
      <div className={`flex flex-col gap-1 min-w-0 flex-1${connector ? ' pb-4' : ''}`}>
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
          {place}
        </span>
        {meta.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground min-w-0 whitespace-nowrap">
            {battery != null && (
              <span className="flex-none inline-flex">
                <BatteryGlyph pct={battery} color={THEME.td} size={18} />
              </span>
            )}
            <span className="overflow-hidden text-ellipsis">{meta.join(' · ')}</span>
          </span>
        )}
      </div>
    </div>
  )
}
