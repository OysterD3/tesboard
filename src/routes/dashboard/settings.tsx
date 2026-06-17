import { Link, createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { useServerFn } from '@tanstack/react-start'
import {
  getLatestVehicleGps,
  reclassifyCharges,
  repairChargeEnergy,
  saveRate,
} from '../../functions/rate.functions'
import { Card, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ACCENT_PALETTE } from '../../components/dashboard/theme'
import { getSupabaseBrowser } from '../../lib/supabase-browser'
import { exportData } from '../../functions/export.functions'
import { getDbInfo, type DbInfo } from '../../functions/diagnostics.functions'
import { downloadString } from '../../lib/download'
import type { ElectricityRate } from '../../types/db'

export const Route = createFileRoute('/dashboard/settings')({
  component: SettingsPage,
})

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

function SettingsPage() {
  const { rate, overview, activeVin } = dashApi.useLoaderData()
  const { theme, units: u, accent, toggleTheme, setUnit, setAccent } = useDash()
  const isDark = theme === 'dark'

  const vw =
    overview.vehicles.find((v) => v.vehicle.vin === activeVin) ?? overview.vehicles[0]
  const vehicleName = vw?.vehicle.display_name || 'Your Tesla'
  const trim = vw?.vehicle.car_type || null

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ViewTitle>Settings</ViewTitle>

      {/* Accent color */}
      <Card radius={22} style={{ padding: '18px 20px' }}>
        <span style={{ fontSize: 15, fontWeight: 500, color: TX }}>Accent color</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 16 }}>
          {ACCENT_PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => setAccent(c)}
              aria-label={`accent ${c}`}
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                cursor: 'pointer',
                border: 'none',
                background: c,
                padding: 0,
                boxShadow: accent === c ? `0 0 0 2px var(--card,#fff), 0 0 0 4px ${c}` : 'none',
              }}
            />
          ))}
        </div>
      </Card>

      {/* Appearance + units */}
      <Card radius={22} style={{ padding: '6px 20px' }}>
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

      <DiagnosticsCard />

      <SignOutRow />

      <span style={{ fontSize: 12, fontWeight: 500, color: TD, textAlign: 'center', lineHeight: 1.6 }}>
        {vehicleName}{trim ? ` · ${trim}` : ''}
      </span>
    </div>
  )
}

function ToggleRow({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '18px 0',
        borderBottom: last ? 'none' : '1px solid var(--border,rgba(0,0,0,0.07))',
        gap: 14,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 500, color: TX }}>{label}</span>
      {children}
    </div>
  )
}

// ── Electricity rate (real data) ─────────────────────────────────────────────

const inputStyle: CSSProperties = {
  width: '100%',
  borderRadius: 12,
  border: '1px solid var(--border,rgba(0,0,0,0.07))',
  background: 'var(--track,#f0f0f3)',
  padding: '10px 12px',
  color: TX,
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 14,
}

// ── Time-of-use schedule helpers ─────────────────────────────────────────────

type DayScope = 'all' | 'weekdays' | 'weekends'
interface BandForm {
  name: string
  start: string // HH:MM
  end: string // HH:MM
  rate: string
  scope: DayScope
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKENDS = [0, 6]

function minToHHMM(m: number): string {
  const mm = ((Math.round(m) % 1440) + 1440) % 1440
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
}
function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map((x) => Number(x))
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}
function daysFromScope(scope: DayScope): number[] | undefined {
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
function bandsFromJson(json: unknown): BandForm[] {
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

function RateForm({
  rate,
  accent,
  activeVin,
}: {
  rate: ElectricityRate | null
  accent: string
  activeVin: string | null
}) {
  const router = useRouter()
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
      router.invalidate()
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
      router.invalidate()
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card radius={22} style={{ padding: 20 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Electricity rate</span>
        <p style={{ margin: '6px 0 16px', fontSize: 12, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
          Home charge cost = energy added × rate × loss factor. Supercharger cost comes from Tesla’s billing.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Currency (ISO)">
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={8} style={inputStyle} />
          </Field>
          <Field label="Price per kWh">
            <input type="number" step="0.0001" min="0" required value={flatRate} onChange={(e) => setFlatRate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Loss factor (≈1.1)">
            <input type="number" step="0.01" min="1" max="2" value={lossFactor} onChange={(e) => setLossFactor(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Nightly charge target %">
            <input type="number" step="1" min="0" max="100" placeholder="80" value={departureTarget} onChange={(e) => setDepartureTarget(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </Card>

      <Card radius={22} style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Time-of-use rate</span>
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
        <p style={{ margin: '6px 0 16px', fontSize: 12, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
          When on, home-charge cost uses the band rate for the time charged (energy split across bands by
          time), overriding the flat rate. Times are local ({minToHHMM(((touOffset % 1440) + 1440) % 1440)} from UTC).
        </p>

        {touEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {bands.map((b, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 14, background: 'var(--track,#f0f0f3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={b.name}
                    onChange={(e) => updateBand(i, { name: e.target.value })}
                    placeholder="Band name"
                    style={{ ...inputStyle, flex: 1, background: 'var(--card,#fff)' }}
                  />
                  <button
                    type="button"
                    onClick={() => removeBand(i)}
                    aria-label="Remove band"
                    style={{ flex: 'none', fontSize: 13, fontWeight: 600, color: '#f43f5e', background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px' }}
                  >
                    Remove
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <Field label="From">
                    <input type="time" value={b.start} onChange={(e) => updateBand(i, { start: e.target.value })} style={{ ...inputStyle, background: 'var(--card,#fff)' }} />
                  </Field>
                  <Field label="To">
                    <input type="time" value={b.end} onChange={(e) => updateBand(i, { end: e.target.value })} style={{ ...inputStyle, background: 'var(--card,#fff)' }} />
                  </Field>
                  <Field label={`${currency}/kWh`}>
                    <input type="number" step="0.0001" min="0" value={b.rate} onChange={(e) => updateBand(i, { rate: e.target.value })} style={{ ...inputStyle, background: 'var(--card,#fff)' }} />
                  </Field>
                </div>
                <Field label="Applies">
                  <select
                    value={b.scope}
                    onChange={(e) => updateBand(i, { scope: e.target.value as DayScope })}
                    style={{ ...inputStyle, background: 'var(--card,#fff)' }}
                  >
                    <option value="all">Every day</option>
                    <option value="weekdays">Weekdays (Mon–Fri)</option>
                    <option value="weekends">Weekends (Sat–Sun)</option>
                  </select>
                </Field>
              </div>
            ))}
            <button
              type="button"
              onClick={addBand}
              style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 600, color: TX, background: 'var(--track,#f0f0f3)', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 30, padding: '8px 14px', cursor: 'pointer' }}
            >
              + Add band
            </button>
            <Field label={`Default rate for uncovered hours (${currency}/kWh, optional)`}>
              <input type="number" step="0.0001" min="0" placeholder="falls back to flat rate if blank" value={touDefault} onChange={(e) => setTouDefault(e.target.value)} style={inputStyle} />
            </Field>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
              Overnight bands are fine — a band whose “to” is earlier than its “from” wraps past midnight. Save, then
              the cost recompute reprices home charges (Supercharger, imported, and manually-edited charges are left alone).
            </p>
          </div>
        )}
      </Card>

      <Link to="/dashboard/geofences" search={(prev) => prev} style={{ textDecoration: 'none' }}>
        <Card radius={22} style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Geofences &amp; per-zone billing</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>Named zones with their own electricity rate →</span>
          </div>
        </Card>
      </Link>

      <Card radius={22} style={{ padding: 20 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Home location</span>
        <p style={{ margin: '6px 0 16px', fontSize: 12, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
          Classify charges home vs away by location. Coordinates stay in your database. For multiple zones, use Geofences above.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Latitude">
              <input type="number" step="0.000001" min="-90" max="90" value={homeLat} onChange={(e) => setHomeLat(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Longitude">
              <input type="number" step="0.000001" min="-180" max="180" value={homeLng} onChange={(e) => setHomeLng(e.target.value)} style={inputStyle} />
            </Field>
          </div>
          <Field label="Radius (m)">
            <input type="number" step="10" min="1" max="5000" value={homeRadius} onChange={(e) => setHomeRadius(e.target.value)} style={inputStyle} />
          </Field>
          <button
            type="button"
            onClick={useCarGps}
            style={{ alignSelf: 'flex-start', fontSize: 13, fontWeight: 600, color: TX, background: 'var(--track,#f0f0f3)', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 30, padding: '8px 14px', cursor: 'pointer' }}
          >
            Use car’s latest GPS
          </button>
          {gpsMsg && <p style={{ margin: 0, fontSize: 12, color: TD }}>{gpsMsg}</p>}
        </div>
      </Card>

      <Card radius={22} style={{ padding: 20 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Maintenance</span>
        <p style={{ margin: '6px 0 16px', fontSize: 12, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
          Recompute home-charge energy from stored snapshots and fix the cost. Run this if a session shows an impossible
          kWh figure. Supercharger and imported charges are left untouched.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={runRepair}
            disabled={repairState.busy}
            style={{ fontSize: 13, fontWeight: 600, color: TX, background: 'var(--track,#f0f0f3)', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 30, padding: '9px 16px', cursor: repairState.busy ? 'default' : 'pointer', opacity: repairState.busy ? 0.6 : 1 }}
          >
            {repairState.busy ? 'Repairing…' : 'Repair charge energy'}
          </button>
          {repairState.text && <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>{repairState.text}</span>}
        </div>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button
          type="submit"
          disabled={busy}
          style={{ fontSize: 14, fontWeight: 600, color: '#fff', background: accent, border: 'none', borderRadius: 30, padding: '11px 20px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {msg && <span style={{ fontSize: 13, fontWeight: 500, color: msg.ok ? '#10b981' : '#f43f5e' }}>{msg.text}</span>}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ fontSize: 12, fontWeight: 600, color: TD }}>
      {label}
      <div style={{ marginTop: 6 }}>{children}</div>
    </label>
  )
}

// ── Data export ──────────────────────────────────────────────────────────────

function ExportCard({ activeVin }: { activeVin: string | null }) {
  const run = useServerFn(exportData)
  const [busy, setBusy] = useState<string | null>(null)

  async function download(dataset: 'charges' | 'drives', format: 'csv' | 'json') {
    const key = `${dataset}-${format}`
    if (busy) return
    setBusy(key)
    try {
      const f = await run({ data: { dataset, format, vin: activeVin ?? undefined } })
      downloadString(f.filename, f.mime, f.body)
    } finally {
      setBusy(null)
    }
  }

  const btn = (dataset: 'charges' | 'drives', format: 'csv' | 'json') => {
    const key = `${dataset}-${format}`
    return (
      <button
        type="button"
        onClick={() => download(dataset, format)}
        disabled={busy != null}
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: TX,
          background: 'var(--track,#f0f0f3)',
          border: '1px solid var(--border,rgba(0,0,0,0.07))',
          borderRadius: 30,
          padding: '8px 14px',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy && busy !== key ? 0.5 : 1,
        }}
      >
        {busy === key ? 'Exporting…' : format.toUpperCase()}
      </button>
    )
  }

  return (
    <Card radius={22} style={{ padding: 20 }}>
      <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Export data</span>
      <p style={{ margin: '6px 0 16px', fontSize: 12, fontWeight: 500, color: TD, lineHeight: 1.5 }}>
        Download your full charge and drive history. Per-drive GPS tracks export as GPX from the Drives tab.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: TX }}>Charges</span>
          <div style={{ display: 'flex', gap: 8 }}>{btn('charges', 'csv')}{btn('charges', 'json')}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: TX }}>Drives</span>
          <div style={{ display: 'flex', gap: 8 }}>{btn('drives', 'csv')}{btn('drives', 'json')}</div>
        </div>
      </div>
    </Card>
  )
}

// ── Database diagnostics ─────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

function DiagnosticsCard() {
  const run = useServerFn(getDbInfo)
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    if (busy) return
    setBusy(true)
    try {
      setInfo(await run())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card radius={22} style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: TX }}>Database</span>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          style={{ fontSize: 13, fontWeight: 600, color: TX, background: 'var(--track,#f0f0f3)', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 30, padding: '7px 14px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Loading…' : info ? 'Refresh' : 'Show'}
        </button>
      </div>
      {info && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {info.tables.map((t) => (
            <div key={t.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: TD, fontFamily: 'monospace' }}>{t.name}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: TX }}>{t.rows.toLocaleString()}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, paddingTop: 12, borderTop: '1px solid var(--border,rgba(0,0,0,0.07))' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Database size</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: TX }}>{info.dbSize ?? '—'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: TD }}>Data since</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: TX }}>{fmtDate(info.oldestSnapshot)} → {fmtDate(info.newestSnapshot)}</span>
          </div>
        </div>
      )}
    </Card>
  )
}

function SignOutRow() {
  const router = useRouter()
  async function signOut() {
    await getSupabaseBrowser().auth.signOut()
    await router.navigate({ to: '/login' })
  }
  return (
    <button
      onClick={signOut}
      style={{ alignSelf: 'center', fontSize: 13, fontWeight: 600, color: TD, background: 'transparent', border: '1px solid var(--border,rgba(0,0,0,0.07))', borderRadius: 30, padding: '9px 18px', cursor: 'pointer' }}
    >
      Sign out
    </button>
  )
}
