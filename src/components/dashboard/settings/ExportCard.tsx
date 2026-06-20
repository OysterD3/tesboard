import { useState } from 'react'
import { useServerFn } from '@tanstack/react-start'
import { cn } from '../../../lib/utils'
import { Card } from '../primitives'
import { exportData } from '../../../functions/export.functions'
import { downloadString } from '../../../lib/download'

export function ExportCard({ activeVin }: { activeVin: string | null }) {
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
        className={cn(
          'text-[13px] font-semibold text-foreground bg-secondary border border-border rounded-full px-3.5 py-2',
          busy ? 'cursor-default' : 'cursor-pointer',
          busy && busy !== key && 'opacity-50',
        )}
      >
        {busy === key ? 'Exporting…' : format.toUpperCase()}
      </button>
    )
  }

  return (
    <Card radius={22} className="p-5">
      <span className="text-[15px] font-semibold text-foreground">Export data</span>
      <p className="mt-1.5 mb-4 text-xs font-medium text-muted-foreground leading-[1.5]">
        Download your full charge and drive history. Per-drive GPS tracks export as GPX from the Drives tab.
      </p>
      <div className="flex flex-col gap-[14px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Charges</span>
          <div className="flex gap-2">{btn('charges', 'csv')}{btn('charges', 'json')}</div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Drives</span>
          <div className="flex gap-2">{btn('drives', 'csv')}{btn('drives', 'json')}</div>
        </div>
      </div>
    </Card>
  )
}
