import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '../../../lib/utils'
import {
  getLatestVehicleGps,
  reclassifyCharges,
  repairChargeEnergy,
  saveRate,
} from '../../../functions/rate.functions'
import { Card, Segmented } from '../primitives'
import { useDash } from '../DashboardProvider'
import type { ElectricityRate } from '../../../types/db'
import { PillButton, Field, inputClass } from './PillButton'
import { TouBands } from './TouBands'
import { bandsFromJson, daysFromScope, hhmmToMin, minToHHMM, type BandForm } from './tou'

export function RateForm({
  rate,
  accent,
  activeVin,
}: {
  rate: ElectricityRate | null
  accent: string
  activeVin: string | null
}) {
  const queryClient = useQueryClient()
  const { theme } = useDash()
  const isDark = theme === 'dark'
  const save = useServerFn(saveRate)
  const getGps = useServerFn(getLatestVehicleGps)
  const reclassify = useServerFn(reclassifyCharges)
  const repair = useServerFn(repairChargeEnergy)
  const [repairState, setRepairState] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null })

  const [currency, setCurrency] = useState(rate?.currency ?? 'USD')
  const [flatRate, setFlatRate] = useState(rate?.flat_rate?.toString() ?? '')
  const [lossFactor, setLossFactor] = useState((rate?.loss_factor ?? 1.1).toString())
  const [departureTarget, setDepartureTarget] = useState(rate?.departure_target_soc?.toString() ?? '')
  const [homeLat, setHomeLat] = useState(rate?.home_lat?.toString() ?? '')
  const [homeLng, setHomeLng] = useState(rate?.home_lng?.toString() ?? '')
  const [homeRadius, setHomeRadius] = useState((rate?.home_radius_m ?? 150).toString())
  const [gpsMsg, setGpsMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Time-of-use tariff. `kind === 'tou'` (or an existing schedule) enables it.
  const initialBands = bandsFromJson(rate?.tou_schedule)
  const [touEnabled, setTouEnabled] = useState(rate?.kind === 'tou' && initialBands.length > 0)
  const [bands, setBands] = useState<BandForm[]>(
    initialBands.length > 0
      ? initialBands
      : [{ name: 'Off-peak', start: '00:00', end: '06:00', rate: '', scope: 'all' }],
  )
  const [touDefault, setTouDefault] = useState(
    (rate?.tou_schedule as { defaultRate?: number } | null)?.defaultRate?.toString() ?? '',
  )
  // Default the local offset to the browser's, falling back to a stored value.
  const [touOffset] = useState<number>(
    (rate?.tou_schedule as { utcOffsetMin?: number } | null)?.utcOffsetMin ??
      (typeof window !== 'undefined' ? -new Date().getTimezoneOffset() : 0),
  )

  function updateBand(i: number, patch: Partial<BandForm>) {
    setBands((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  }
  function addBand() {
    setBands((bs) => [...bs, { name: 'Band', start: '00:00', end: '00:00', rate: '', scope: 'all' }])
  }
  function removeBand(i: number) {
    setBands((bs) => bs.filter((_, j) => j !== i))
  }

  const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))

  async function runRepair() {
    if (repairState.busy) return
    setRepairState({ busy: true, text: null })
    try {
      const r = await repair()
      setRepairState({ busy: false, text: `Scanned ${r.scanned} session(s), corrected ${r.repaired}.` })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (err) {
      setRepairState({ busy: false, text: (err as Error).message })
    }
  }

  async function useCarGps() {
    setGpsMsg(null)
    try {
      const gps = await getGps({ data: { vin: activeVin ?? undefined } })
      if (!gps) {
        setGpsMsg('No stored GPS fix yet — the poller needs at least one reading with location.')
        return
      }
      setHomeLat(gps.lat.toString())
      setHomeLng(gps.lng.toString())
      setGpsMsg(`Filled from the car’s location as of ${new Date(gps.recorded_at).toLocaleString()}.`)
    } catch (err) {
      setGpsMsg((err as Error).message)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const homeLatNum = num(homeLat)
      const homeLngNum = num(homeLng)
      const touBands = touEnabled
        ? bands
            .filter((b) => b.rate.trim() !== '' && !Number.isNaN(Number(b.rate)))
            .map((b) => ({
              name: b.name.trim() || 'Band',
              rate: Number(b.rate),
              startMin: hhmmToMin(b.start),
              endMin: hhmmToMin(b.end),
              days: daysFromScope(b.scope),
            }))
        : []
      const touSchedule =
        touEnabled && touBands.length > 0
          ? { bands: touBands, defaultRate: num(touDefault), utcOffsetMin: touOffset }
          : null
      await save({
        data: {
          currency,
          flatRate: Number(flatRate),
          lossFactor: Number(lossFactor),
          homeLat: homeLatNum,
          homeLng: homeLngNum,
          homeRadiusM: num(homeRadius),
          departureTargetSoc: num(departureTarget),
          touSchedule,
        },
      })
      let text = 'Saved.'
      if (homeLatNum != null && homeLngNum != null) {
        const r = await reclassify()
        text = `Saved. Reclassified ${r.reclassified} charge(s), recomputed cost on ${r.recosted}.`
      }
      setMsg({ ok: true, text })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-[14px]">
      <Card radius={22} className="p-5">
        <span className="text-[15px] font-semibold text-foreground">Electricity rate</span>
        <p className="mt-1.5 mb-4 text-xs font-medium text-muted-foreground leading-[1.5]">
          Home charge cost = energy added × rate × loss factor. Supercharger cost comes from Tesla’s billing.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Currency (ISO)">
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={8} className={inputClass} />
          </Field>
          <Field label="Price per kWh">
            <input type="number" step="0.0001" min="0" required value={flatRate} onChange={(e) => setFlatRate(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Loss factor (≈1.1)">
            <input type="number" step="0.01" min="1" max="2" value={lossFactor} onChange={(e) => setLossFactor(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Nightly charge target %">
            <input type="number" step="1" min="0" max="100" placeholder="80" value={departureTarget} onChange={(e) => setDepartureTarget(e.target.value)} className={inputClass} />
          </Field>
        </div>
      </Card>

      <Card radius={22} className="p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-semibold text-foreground">Time-of-use rate</span>
          <Segmented
            options={[
              { label: 'Off', value: 'off' as const },
              { label: 'On', value: 'on' as const },
            ]}
            value={touEnabled ? 'on' : 'off'}
            onChange={(v) => setTouEnabled(v === 'on')}
            accent={accent}
            isDark={isDark}
          />
        </div>
        <p className="mt-1.5 mb-4 text-xs font-medium text-muted-foreground leading-[1.5]">
          When on, home-charge cost uses the band rate for the time charged (energy split across bands by
          time), overriding the flat rate. Times are local ({minToHHMM(((touOffset % 1440) + 1440) % 1440)} from UTC).
        </p>

        {touEnabled && (
          <TouBands
            bands={bands}
            currency={currency}
            touDefault={touDefault}
            onUpdateBand={updateBand}
            onAddBand={addBand}
            onRemoveBand={removeBand}
            onTouDefaultChange={setTouDefault}
          />
        )}
      </Card>

      <Link to="/dashboard/geofences" search={(prev) => prev} className="no-underline">
        <Card radius={22} className="px-5 py-4 flex items-center justify-between">
          <div className="flex flex-col gap-[3px]">
            <span className="text-[15px] font-semibold text-foreground">Geofences &amp; per-zone billing</span>
            <span className="text-xs font-medium text-muted-foreground">Named zones with their own electricity rate →</span>
          </div>
        </Card>
      </Link>

      <Card radius={22} className="p-5">
        <span className="text-[15px] font-semibold text-foreground">Home location</span>
        <p className="mt-1.5 mb-4 text-xs font-medium text-muted-foreground leading-[1.5]">
          Classify charges home vs away by location. Coordinates stay in your database. For multiple zones, use Geofences above.
        </p>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude">
              <input type="number" step="0.000001" min="-90" max="90" value={homeLat} onChange={(e) => setHomeLat(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Longitude">
              <input type="number" step="0.000001" min="-180" max="180" value={homeLng} onChange={(e) => setHomeLng(e.target.value)} className={inputClass} />
            </Field>
          </div>
          <Field label="Radius (m)">
            <input type="number" step="10" min="1" max="5000" value={homeRadius} onChange={(e) => setHomeRadius(e.target.value)} className={inputClass} />
          </Field>
          <PillButton onClick={useCarGps} className="self-start">Use car’s latest GPS</PillButton>
          {gpsMsg && <p className="m-0 text-xs text-muted-foreground">{gpsMsg}</p>}
        </div>
      </Card>

      <Card radius={22} className="p-5">
        <span className="text-[15px] font-semibold text-foreground">Maintenance</span>
        <p className="mt-1.5 mb-4 text-xs font-medium text-muted-foreground leading-[1.5]">
          Recompute home-charge energy from stored snapshots and fix the cost. Run this if a session shows an impossible
          kWh figure. Supercharger and imported charges are left untouched.
        </p>
        <div className="flex items-center gap-[14px] flex-wrap">
          <PillButton onClick={runRepair} busy={repairState.busy}>
            {repairState.busy ? 'Repairing…' : 'Repair charge energy'}
          </PillButton>
          {repairState.text && <span className="text-[13px] font-medium text-muted-foreground">{repairState.text}</span>}
        </div>
      </Card>

      <div className="flex items-center gap-[14px] flex-wrap">
        <button
          type="submit"
          disabled={busy}
          className={cn('text-sm font-semibold text-white border-0 rounded-full px-5 py-[11px]', busy ? 'cursor-default opacity-60' : 'cursor-pointer')}
          style={{ background: accent }}
        >
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {msg && <span className={cn('text-[13px] font-medium', msg.ok ? 'text-emerald-500' : 'text-destructive')}>{msg.text}</span>}
      </div>
    </form>
  )
}
