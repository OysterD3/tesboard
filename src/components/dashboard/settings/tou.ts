// Time-of-use tariff schedule helpers + form types, shared by RateForm/TouBands.

export type DayScope = 'all' | 'weekdays' | 'weekends'
export interface BandForm {
  name: string
  start: string // HH:MM
  end: string // HH:MM
  rate: string
  scope: DayScope
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKENDS = [0, 6]

export function minToHHMM(m: number): string {
  const mm = ((Math.round(m) % 1440) + 1440) % 1440
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
}
export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map((x) => Number(x))
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}
export function daysFromScope(scope: DayScope): number[] | undefined {
  if (scope === 'weekdays') return WEEKDAYS
  if (scope === 'weekends') return WEEKENDS
  return undefined
}
function scopeFromDays(days: unknown): DayScope {
  if (!Array.isArray(days) || days.length === 0) return 'all'
  const set = [...days].sort().join(',')
  if (set === WEEKDAYS.join(',')) return 'weekdays'
  if (set === WEEKENDS.join(',')) return 'weekends'
  return 'all'
}

/** Parse the stored jsonb tou_schedule into editable band rows. */
export function bandsFromJson(json: unknown): BandForm[] {
  if (!json || typeof json !== 'object') return []
  const bands = (json as { bands?: unknown }).bands
  if (!Array.isArray(bands)) return []
  return bands.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>
    return {
      name: typeof o.name === 'string' ? o.name : 'Band',
      start: minToHHMM(Number(o.startMin) || 0),
      end: minToHHMM(Number(o.endMin) || 0),
      rate: o.rate != null ? String(o.rate) : '',
      scope: scopeFromDays(o.days),
    }
  })
}
