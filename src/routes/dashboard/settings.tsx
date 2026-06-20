import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { useDashboardData } from '../../lib/queries'
import { Card, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ACCENT_PALETTE } from '../../components/dashboard/theme'
import { RateForm } from '../../components/dashboard/settings/RateForm'
import { ExportCard } from '../../components/dashboard/settings/ExportCard'
import { BackfillCard } from '../../components/dashboard/settings/BackfillCard'
import { DiagnosticsCard } from '../../components/dashboard/settings/DiagnosticsCard'
import { SignOutRow } from '../../components/dashboard/settings/SignOutRow'

export const Route = createFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  const { rate, overview, activeVin } = useDashboardData()
  const { theme, units: u, accent, toggleTheme, setUnit, setAccent } = useDash()
  const isDark = theme === 'dark'

  const vw =
    overview.vehicles.find((v) => v.vehicle.vin === activeVin) ?? overview.vehicles[0]
  const vehicleName = vw?.vehicle.display_name || 'Your Tesla'
  const trim = vw?.vehicle.car_type || null

  return (
    <div className={cn('evd-view flex flex-col gap-[14px]')}>
      <ViewTitle>Settings</ViewTitle>

      {/* Accent color */}
      <Card radius={22} className="px-5 py-[18px]">
        <span className="text-[15px] font-medium text-foreground">Accent color</span>
        <div className="flex flex-wrap gap-[14px] mt-4">
          {ACCENT_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setAccent(c)}
              aria-label={`accent ${c}`}
              className="w-[30px] h-[30px] rounded-full cursor-pointer border-0 p-0"
              style={{
                background: c,
                boxShadow: accent === c ? `0 0 0 2px var(--card,#fff), 0 0 0 4px ${c}` : 'none',
              }}
            />
          ))}
        </div>
      </Card>

      {/* Appearance + units */}
      <Card radius={22} className="px-5 py-1.5">
        <ToggleRow label="Appearance">
          <Segmented
            options={[
              { label: 'Light', value: 'light' as const },
              { label: 'Dark', value: 'dark' as const },
            ]}
            value={theme}
            onChange={(v) => {
              if (v !== theme) toggleTheme()
            }}
            accent={accent}
            isDark={isDark}
          />
        </ToggleRow>
        <ToggleRow label="Distance">
          <Segmented
            options={[
              { label: 'mi', value: 'mi' as const },
              { label: 'km', value: 'km' as const },
            ]}
            value={u.dist}
            onChange={(v) => setUnit('dist', v)}
            accent={accent}
            isDark={isDark}
          />
        </ToggleRow>
        <ToggleRow label="Temperature">
          <Segmented
            options={[
              { label: '°F', value: 'f' as const },
              { label: '°C', value: 'c' as const },
            ]}
            value={u.temp}
            onChange={(v) => setUnit('temp', v)}
            accent={accent}
            isDark={isDark}
          />
        </ToggleRow>
        <ToggleRow label="Tire pressure">
          <Segmented
            options={[
              { label: 'psi', value: 'psi' as const },
              { label: 'bar', value: 'bar' as const },
            ]}
            value={u.pres}
            onChange={(v) => setUnit('pres', v)}
            accent={accent}
            isDark={isDark}
          />
        </ToggleRow>
        <ToggleRow label="Efficiency" last>
          <Segmented
            options={[
              { label: 'mi/kWh', value: 'mi' as const },
              { label: 'Wh/km', value: 'whkm' as const },
            ]}
            value={u.eff}
            onChange={(v) => setUnit('eff', v)}
            accent={accent}
            isDark={isDark}
          />
        </ToggleRow>
      </Card>

      <RateForm rate={rate} accent={accent} activeVin={activeVin} />

      <ExportCard activeVin={activeVin} />

      <BackfillCard />

      <DiagnosticsCard />

      <SignOutRow />

      <span className="text-xs font-medium text-muted-foreground text-center leading-[1.6]">
        {vehicleName}{trim ? ` · ${trim}` : ''}
      </span>
    </div>
  )
}

function ToggleRow({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between py-[18px] gap-[14px]', !last && 'border-b border-border')}>
      <span className="text-[15px] font-medium text-foreground">{label}</span>
      {children}
    </div>
  )
}
