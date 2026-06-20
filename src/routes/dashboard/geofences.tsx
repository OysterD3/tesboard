import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Card, EmptyCard, Icon, ViewTitle } from '../../components/dashboard/primitives'
import { useDash } from '../../components/dashboard/DashboardProvider'
import { useDashboardData } from '../../lib/queries'
import { ICON, THEME } from '../../components/dashboard/theme'
import { cn } from '../../lib/utils'
import { deleteGeofence, upsertGeofence } from '../../functions/geofences.functions'
import { getLatestVehicleGps } from '../../functions/rate.functions'
import type { BillingType, Geofence } from '../../types/db'

export const Route = createFileRoute('/dashboard/geofences')({ component: GeofencesPage })

const inputClass =
  'w-full border border-border rounded-[10px] px-[11px] py-[9px] text-sm font-sans bg-card text-foreground box-border'

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
  const { geofences, activeVin } = useDashboardData()
  const { accent } = useDash()
  const queryClient = useQueryClient()
  const save = useServerFn(upsertGeofence)
  const del = useServerFn(deleteGeofence)
  const getGps = useServerFn(getLatestVehicleGps)

  const saveMutation = useMutation({
    mutationFn: save,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })
  const deleteMutation = useMutation({
    mutationFn: del,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const busy = saveMutation.isPending || deleteMutation.isPending

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  async function submit() {
    if (!draft) return
    const lat = Number(draft.lat)
    const lng = Number(draft.lng)
    if (!draft.name.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      setMsg('Name and a valid latitude/longitude are required.')
      return
    }
    setMsg(null)
    try {
      await saveMutation.mutateAsync({
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
    } catch (e) {
      setMsg((e as Error).message)
    }
  }

  async function remove(id: number) {
    try {
      await deleteMutation.mutateAsync({ data: { id } })
      setDraft(null)
    } catch {
      /* keep the editor open on failure */
    }
  }

  async function useCarGps() {
    const gps = await getGps({ data: { vin: activeVin ?? undefined } })
    if (gps) setDraft((d) => (d ? { ...d, lat: gps.lat.toFixed(6), lng: gps.lng.toFixed(6) } : d))
    else setMsg('No GPS fix recorded yet.')
  }

  return (
    <div className="evd-view flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        <ViewTitle>Geofences</ViewTitle>
        {!draft && (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="rounded-[30px] px-4 py-2 text-[13px] font-semibold text-white cursor-pointer border-none"
            style={{ background: accent }}
          >
            + Add zone
          </button>
        )}
      </div>

      {draft && (
        <Card radius={20} className="p-[18px] flex flex-col gap-3">
          <span className="text-sm font-bold text-foreground">{draft.id ? 'Edit zone' : 'New zone'}</span>
          <Field label="Name"><Input value={draft.name} onChange={(v) => set('name', v)} placeholder="Home, Work, …" /></Field>
          <div className="flex gap-2.5">
            <Field label="Latitude"><Input value={draft.lat} onChange={(v) => set('lat', v)} placeholder="37.123456" /></Field>
            <Field label="Longitude"><Input value={draft.lng} onChange={(v) => set('lng', v)} placeholder="-122.123456" /></Field>
          </div>
          <button
            onClick={useCarGps}
            className="border-none bg-transparent text-[13px] font-semibold cursor-pointer p-0 text-left"
            style={{ color: accent }}
          >
            Use car’s current GPS
          </button>
          <div className="flex gap-2.5">
            <Field label="Radius (m)"><Input value={draft.radiusM} onChange={(v) => set('radiusM', v)} /></Field>
            <Field label="Billing">
              <select
                value={draft.billingType}
                onChange={(e) => set('billingType', e.target.value as BillingType)}
                className={inputClass}
              >
                <option value="per_kwh">Per kWh</option>
                <option value="per_minute">Per minute</option>
                <option value="per_session">Per session</option>
              </select>
            </Field>
          </div>
          <div className="flex gap-2.5">
            <Field label={draft.billingType === 'per_session' ? 'Rate (unused)' : 'Cost / unit'}>
              <Input value={draft.costPerUnit} onChange={(v) => set('costPerUnit', v)} placeholder="0.15" />
            </Field>
            <Field label="Session fee"><Input value={draft.sessionFee} onChange={(v) => set('sessionFee', v)} placeholder="0" /></Field>
            <Field label="Currency"><Input value={draft.currency} onChange={(v) => set('currency', v)} /></Field>
          </div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-foreground cursor-pointer">
            <input type="checkbox" checked={draft.isHome} onChange={(e) => set('isHome', e.target.checked)} />
            This is my home zone (used for home-rate cost + departure readiness)
          </label>
          {msg && <span className="text-xs font-medium text-destructive">{msg}</span>}
          <div className="flex gap-2.5 mt-1">
            <button
              onClick={submit}
              disabled={busy}
              className={cn('flex-1 rounded-xl p-[11px] text-sm font-semibold text-white cursor-pointer border-none', busy && 'opacity-60')}
              style={{ background: accent }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {draft.id && (
              <button
                onClick={() => remove(draft.id!)}
                disabled={busy}
                className="rounded-xl px-4 py-[11px] text-sm font-semibold cursor-pointer border border-destructive text-destructive bg-transparent"
              >
                Delete
              </button>
            )}
            <button
              onClick={() => setDraft(null)}
              className="rounded-xl px-4 py-[11px] text-sm font-semibold cursor-pointer border border-border text-muted-foreground bg-transparent"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {geofences.length === 0 && !draft ? (
        <EmptyCard title="No geofences yet" body="Add named zones (home, work, a friend's place) with their own electricity rate. Charges inside a zone are costed by its rule; the home zone also drives departure readiness." />
      ) : (
        geofences.map((g) => (
          <Card key={g.id} radius={18} className="p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span
                className={cn(
                  'w-9 h-9 rounded-[10px] flex items-center justify-center flex-none',
                  g.is_home ? 'bg-[rgba(52,199,89,0.13)]' : 'bg-secondary',
                )}
              >
                <Icon d={ICON.pin} size={18} color={g.is_home ? '#34c759' : THEME.td} />
              </span>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-semibold text-foreground">
                  {g.name}{g.is_home ? ' · home' : ''}
                </span>
                <span className="text-xs font-medium text-muted-foreground">
                  {(g.cost_per_unit != null
                    ? `${g.cost_per_unit} ${g.currency ?? ''} / ${g.billing_type === 'per_minute' ? 'min' : 'kWh'}`
                    : g.session_fee != null
                      ? `${g.session_fee} ${g.currency ?? ''} / session`
                      : 'no rate') + ` · r=${Math.round(g.radius_m)}m`}
                </span>
              </div>
            </div>
            <button
              onClick={() => setDraft(toDraft(g))}
              className="border-none bg-transparent text-[13px] font-semibold cursor-pointer p-0 text-left"
              style={{ color: accent }}
            >
              Edit
            </button>
          </Card>
        ))
      )}
    </div>
  )
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputClass} />
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-[5px] flex-1 min-w-0">
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
