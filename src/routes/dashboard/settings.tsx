import { Link, createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { useServerFn } from '@tanstack/react-start'
import {
  getLatestVehicleGps,
  reclassifyCharges,
  saveRate,
} from '../../functions/rate.functions'
import { Card, Segmented, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ACCENT_PALETTE } from '../../components/dashboard/theme'
import { getSupabaseBrowser } from '../../lib/supabase-browser'
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
  const save = useServerFn(saveRate)
  const getGps = useServerFn(getLatestVehicleGps)
  const reclassify = useServerFn(reclassifyCharges)

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

  const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))

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
      await save({
        data: {
          currency,
          flatRate: Number(flatRate),
          lossFactor: Number(lossFactor),
          homeLat: homeLatNum,
          homeLng: homeLngNum,
          homeRadiusM: num(homeRadius),
          departureTargetSoc: num(departureTarget),
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
