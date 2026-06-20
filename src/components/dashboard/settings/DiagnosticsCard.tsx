import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { Card } from '../primitives'
import { getDbInfo, type DbInfo } from '../../../functions/diagnostics.functions'
import { PillButton } from './PillButton'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

export function DiagnosticsCard() {
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
    <Card radius={22} className="p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold text-foreground">Database</span>
        <PillButton onClick={load} busy={busy} className="py-[7px]">
          {busy ? 'Loading…' : info ? 'Refresh' : 'Show'}
        </PillButton>
      </div>
      {info && (
        <div className="mt-4 flex flex-col gap-2.5">
          {info.tables.map((t) => (
            <div key={t.name} className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-muted-foreground font-mono">{t.name}</span>
              <span className="text-[13px] font-semibold text-foreground">{t.rows.toLocaleString()}</span>
            </div>
          ))}
          <div className="flex items-center justify-between mt-1.5 pt-3 border-t border-border">
            <span className="text-[13px] font-medium text-muted-foreground">Database size</span>
            <span className="text-[13px] font-semibold text-foreground">{info.dbSize ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted-foreground">Data since</span>
            <span className="text-[13px] font-semibold text-foreground">{fmtDate(info.oldestSnapshot)} → {fmtDate(info.newestSnapshot)}</span>
          </div>
        </div>
      )}
    </Card>
  )
}
