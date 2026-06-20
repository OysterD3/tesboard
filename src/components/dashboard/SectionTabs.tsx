import { useNavigate } from '@tanstack/react-router'
import { Segmented } from './primitives'

export type SectionView = 'history' | 'map' | 'insights'

const VIEW_OPTIONS = [
  { label: 'History', value: 'history' as const },
  { label: 'Map', value: 'map' as const },
  { label: 'Insights', value: 'insights' as const },
]

/**
 * The History / Map / Insights toggle shared by the Drives, Charging and Idles
 * sections. Each value routes to a dedicated un-nested sibling route
 * (`/dashboard/<section>`, `…/map`, `…/insights`); `vin` and any other search
 * params are preserved across the switch. The `to` targets are spelled out as
 * literals per section so TanStack's route typing stays intact (a computed path
 * would degrade to `string` and lose checking).
 */
export function SectionTabs({
  section,
  value,
  accent,
  isDark,
}: {
  section: 'drives' | 'charging' | 'idles'
  value: SectionView
  accent: string
  isDark: boolean
}) {
  const navigate = useNavigate()

  function go(v: SectionView) {
    if (v === value) return
    if (section === 'drives') {
      navigate({
        to:
          v === 'history'
            ? '/dashboard/drives'
            : v === 'map'
              ? '/dashboard/drives/map'
              : '/dashboard/drives/insights',
        search: (prev) => prev,
      })
    } else if (section === 'charging') {
      navigate({
        to:
          v === 'history'
            ? '/dashboard/charging'
            : v === 'map'
              ? '/dashboard/charging/map'
              : '/dashboard/charging/insights',
        search: (prev) => prev,
      })
    } else {
      navigate({
        to:
          v === 'history'
            ? '/dashboard/idles'
            : v === 'map'
              ? '/dashboard/idles/map'
              : '/dashboard/idles/insights',
        search: (prev) => prev,
      })
    }
  }

  return <Segmented options={VIEW_OPTIONS} value={value} onChange={go} accent={accent} isDark={isDark} />
}
