import { cn } from '../../../lib/utils'
import { PillButton, Field, inputClass } from './PillButton'
import type { BandForm, DayScope } from './tou'

const bandInputClass = cn(inputClass, 'bg-card')

/** The editable list of time-of-use bands + the per-uncovered-hours default rate. */
export function TouBands({
  bands,
  currency,
  touDefault,
  onUpdateBand,
  onAddBand,
  onRemoveBand,
  onTouDefaultChange,
}: {
  bands: BandForm[]
  currency: string
  touDefault: string
  onUpdateBand: (i: number, patch: Partial<BandForm>) => void
  onAddBand: () => void
  onRemoveBand: (i: number) => void
  onTouDefaultChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      {bands.map((b, i) => (
        <div key={i} className="flex flex-col gap-2 p-3 rounded-[14px] bg-secondary">
          <div className="flex items-center gap-2">
            <input
              value={b.name}
              onChange={(e) => onUpdateBand(i, { name: e.target.value })}
              placeholder="Band name"
              className={cn(bandInputClass, 'flex-1')}
            />
            <button
              type="button"
              onClick={() => onRemoveBand(i)}
              aria-label="Remove band"
              className="flex-none text-[13px] font-semibold text-destructive bg-transparent border-0 cursor-pointer px-1.5"
            >
              Remove
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="From">
              <input type="time" value={b.start} onChange={(e) => onUpdateBand(i, { start: e.target.value })} className={bandInputClass} />
            </Field>
            <Field label="To">
              <input type="time" value={b.end} onChange={(e) => onUpdateBand(i, { end: e.target.value })} className={bandInputClass} />
            </Field>
            <Field label={`${currency}/kWh`}>
              <input type="number" step="0.0001" min="0" value={b.rate} onChange={(e) => onUpdateBand(i, { rate: e.target.value })} className={bandInputClass} />
            </Field>
          </div>
          <Field label="Applies">
            <select
              value={b.scope}
              onChange={(e) => onUpdateBand(i, { scope: e.target.value as DayScope })}
              className={bandInputClass}
            >
              <option value="all">Every day</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="weekends">Weekends (Sat–Sun)</option>
            </select>
          </Field>
        </div>
      ))}
      <PillButton onClick={onAddBand} className="self-start">+ Add band</PillButton>
      <Field label={`Default rate for uncovered hours (${currency}/kWh, optional)`}>
        <input type="number" step="0.0001" min="0" placeholder="falls back to flat rate if blank" value={touDefault} onChange={(e) => onTouDefaultChange(e.target.value)} className={inputClass} />
      </Field>
      <p className="m-0 text-[11px] font-medium text-muted-foreground leading-[1.5]">
        Overnight bands are fine — a band whose “to” is earlier than its “from” wraps past midnight. Save, then
        the cost recompute reprices home charges (Supercharger, imported, and manually-edited charges are left alone).
      </p>
    </div>
  )
}
