import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { ICON } from '../../components/dashboard/theme'
import { deleteGeofence, upsertGeofence } from '../../functions/geofences.functions'
import { getLatestVehicleGps } from '../../functions/rate.functions'
import type { BillingType, Geofence } from '../../types/db'

export const Route = createFileRoute('/dashboard/geofences')({ component: GeofencesPage })

const dashApi = getRouteApi('/dashboard')
const TD = 'var(--td,#86868b)'
const TX = 'var(--tx,#1d1d1f)'

interface Draft {
  id: number | null
  name: string
  lat: string
  lng: string
  radiusM: string
  billingType: BillingType
  costPerUnit: string
  sessionFee: string
  currency: string
  isHome: boolean
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: '',
    lat: '',
    lng: '',
    radiusM: '150',
    billingType: 'per_kwh',
    costPerUnit: '',
    sessionFee: '',
    currency: 'USD',
    isHome: false,
  }
}

function toDraft(g: Geofence): Draft {
  return {
    id: g.id,
    name: g.name,
    lat: g.lat?.toString() ?? '',
    lng: g.lng?.toString() ?? '',
    radiusM: (g.radius_m ?? 150).toString(),
    billingType: g.billing_type,
    costPerUnit: g.cost_per_unit?.toString() ?? '',
    sessionFee: g.session_fee?.toString() ?? '',
    currency: g.currency ?? 'USD',
    isHome: g.is_home,
  }
}

function GeofencesPage() {
  const { geofences, activeVin } = dashApi.useLoaderData()
  const { accent } = useDash()
  const router = useRouter()
  const save = useServerFn(upsertGeofence)
  const del = useServerFn(deleteGeofence)
  const getGps = useServerFn(getLatestVehicleGps)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  async function submit() {
    if (!draft) return
    const lat = Number(draft.lat)
    const lng = Number(draft.lng)
    if (!draft.name.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      setMsg('Name and a valid latitude/longitude are required.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await save({
        data: {
          id: draft.id,
          name: draft.name.trim(),
          lat,
          lng,
          radiusM: Number(draft.radiusM) || 150,
          billingType: draft.billingType,
          costPerUnit: draft.costPerUnit ? Number(draft.costPerUnit) : null,
          sessionFee: draft.sessionFee ? Number(draft.sessionFee) : null,
          currency: draft.currency || null,
          isHome: draft.isHome,
        },
      })
      setDraft(null)
      router.invalidate()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    setBusy(true)
    try {
      await del({ data: { id } })
      setDraft(null)
      router.invalidate()
    } finally {
      setBusy(false)
    }
  }

  async function useCarGps() {
    const gps = await getGps({ data: { vin: activeVin ?? undefined } })
    if (gps) setDraft((d) => (d ? { ...d, lat: gps.lat.toFixed(6), lng: gps.lng.toFixed(6) } : d))
    else setMsg('No GPS fix recorded yet.')
  }

  return (
    <div className="evd-view" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <ViewTitle>Geofences</ViewTitle>
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            style={{ border: 'none', background: accent, color: '#fff', borderRadius: 30, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            + Add zone
          </button>
        )}
      </div>

      {draft && (
        <Card radius={20} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: TX }}>{draft.id ? 'Edit zone' : 'New zone'}</span>
          <Field label="Name"><Input value={draft.name} onChange={(v) => set('name', v)} placeholder="Home, Work, …" /></Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Latitude"><Input value={draft.lat} onChange={(v) => set('lat', v)} placeholder="37.123456" /></Field>
            <Field label="Longitude"><Input value={draft.lng} onChange={(v) => set('lng', v)} placeholder="-122.123456" /></Field>
          </div>
          <button onClick={useCarGps} style={linkBtn(accent)}>Use car’s current GPS</button>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Radius (m)"><Input value={draft.radiusM} onChange={(v) => set('radiusM', v)} /></Field>
            <Field label="Billing">
              <select
                value={draft.billingType}
                onChange={(e) => set('billingType', e.target.value as BillingType)}
                style={inputStyle}
              >
                <option value="per_kwh">Per kWh</option>
                <option value="per_minute">Per minute</option>
                <option value="per_session">Per session</option>
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label={draft.billingType === 'per_session' ? 'Rate (unused)' : 'Cost / unit'}>
              <Input value={draft.costPerUnit} onChange={(v) => set('costPerUnit', v)} placeholder="0.15" />
            </Field>
            <Field label="Session fee"><Input value={draft.sessionFee} onChange={(v) => set('sessionFee', v)} placeholder="0" /></Field>
            <Field label="Currency"><Input value={draft.currency} onChange={(v) => set('currency', v)} /></Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, color: TX, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.isHome} onChange={(e) => set('isHome', e.target.checked)} />
            This is my home zone (used for home-rate cost + departure readiness)
          </label>
          {msg && <span style={{ fontSize: 12, color: '#f43f5e', fontWeight: 500 }}>{msg}</span>}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={submit} disabled={busy} style={{ flex: 1, border: 'none', background: accent, color: '#fff', borderRadius: 12, padding: '11px', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {draft.id && (
              <button onClick={() => remove(draft.id!)} disabled={busy} style={{ border: '1px solid #f43f5e', background: 'transparent', color: '#f43f5e', borderRadius: 12, padding: '11px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Delete
              </button>
            )}
            <button onClick={() => setDraft(null)} style={{ border: '1px solid var(--border,rgba(0,0,0,0.1))', background: 'transparent', color: TD, borderRadius: 12, padding: '11px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {geofences.length === 0 && !draft ? (
        <EmptyCard title="No geofences yet" body="Add named zones (home, work, a friend's place) with their own electricity rate. Charges inside a zone are costed by its rule; the home zone also drives departure readiness." />
      ) : (
        geofences.map((g) => (
          <Card key={g.id} radius={18} style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span style={{ width: 36, height: 36, borderRadius: 10, background: g.is_home ? 'rgba(52,199,89,0.13)' : 'var(--track,#f0f0f3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Icon d={ICON.pin} size={18} color={g.is_home ? '#34c759' : TD} />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: TX }}>
                  {g.name}{g.is_home ? ' · home' : ''}
                </span>
                <span style={{ fontSize: 12, fontWeight: 500, color: TD }}>
                  {(g.cost_per_unit != null
                    ? `${g.cost_per_unit} ${g.currency ?? ''} / ${g.billing_type === 'per_minute' ? 'min' : 'kWh'}`
                    : g.session_fee != null
                      ? `${g.session_fee} ${g.currency ?? ''} / session`
                      : 'no rate') + ` · r=${Math.round(g.radius_m)}m`}
                </span>
              </div>
            </div>
            <button onClick={() => setDraft(toDraft(g))} style={linkBtn(accent)}>Edit</button>
          </Card>
        ))
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--border,rgba(0,0,0,0.12))',
  borderRadius: 10,
  padding: '9px 11px',
  fontSize: 14,
  fontFamily: 'inherit',
  background: 'var(--card,#fff)',
  color: 'var(--tx,#1d1d1f)',
  boxSizing: 'border-box',
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: TD }}>{label}</span>
      {children}
    </label>
  )
}

function linkBtn(accent: string): React.CSSProperties {
  return { border: 'none', background: 'transparent', color: accent, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0, textAlign: 'left' }
}
