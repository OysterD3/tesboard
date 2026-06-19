/**
 * Merge fragmented charge sessions into one row per physical plug-in.
 *
 * Stop/start charging (e.g. unplug/replug to reset a balky AC charger) records one
 * plug-in as several charge_session rows. This collapses each run of fragments into
 * its earliest row (the SURVIVOR): summed energy/cost, spanned time/range/SOC; the
 * absorbed rows are deleted and their vehicle_snapshot.source_charge_id links are
 * repointed to the survivor (anomaly_flag rows cascade-delete). Clustering rules +
 * field math live in ./charges/merge.mjs (unit-tested).
 *
 * Sessions sharing a QuickCharge receipt number always merge (authoritative plug-in
 * boundary); other adjacent fragments merge only within --gap-min. Idempotent: a
 * survivor re-clustered later stands alone, so re-runs are no-ops.
 *
 * Writes via the DIRECT (session, :5432) connection. Run --dry-run first.
 *
 * Usage:
 *   pnpm merge:charges <tesboard-user-email> [--dry-run] [--gap-min=1] [--include-supercharger] [--vin=VIN]
 */
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { planMerges } from './charges/merge.mjs'

function loadFromFile(path, key) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* file may not exist */
  }
  return undefined
}
const resolve = (key) =>
  process.env[key] || loadFromFile('.dev.vars', key) || loadFromFile('.env', key) || ''

const argv = process.argv.slice(2)
const email = argv.filter((a) => !a.startsWith('--'))[0]
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.split('=')[1] : d
}

if (!email) {
  console.error('Usage: node scripts/merge-charges.mjs <tesboard-user-email> [--dry-run] [--gap-min=1] [--include-supercharger] [--vin=VIN]')
  process.exit(1)
}
const DRY = flag('dry-run')
const GAP_MS = Number(opt('gap-min', '1')) * 60_000
const INCLUDE_SC = flag('include-supercharger')
const VIN = opt('vin', null)

const TB_URL = resolve('DIRECT_URL') || resolve('DATABASE_URL')
if (!TB_URL) {
  console.error('Missing DIRECT_URL / DATABASE_URL (use the :5432 session URL).')
  process.exit(1)
}

const log = (...a) => console.log(...a)
const r2 = (n) => (n == null ? '—' : Number(n).toFixed(2))
const tb = postgres(TB_URL, { max: 3, prepare: false, idle_timeout: 20 })

try {
  const [user] = await tb`select id from auth.users where email = ${email} limit 1`
  if (!user) throw new Error(`No tesboard user with email ${email}.`)
  const userId = user.id

  const rows = (
    await tb`
      select id, vin, source, started_at, ended_at, energy_added_kwh, energy_used_kwh,
        cost_amount, cost_currency, cost_source, rate_applied, miles_added_rated,
        start_range_mi, end_range_mi, start_battery_level, end_battery_level,
        outside_temp_avg, geofence_id, invoices
      from charge_session
      where user_id = ${userId} and ended_at is not null
        ${INCLUDE_SC ? tb`` : tb`and source <> 'supercharger'`}
        ${VIN ? tb`and vin = ${VIN}` : tb``}
      order by vin, started_at`
  ).map((s) => ({
    ...s,
    id: Number(s.id),
    started_at: new Date(s.started_at).toISOString(),
    ended_at: new Date(s.ended_at).toISOString(),
    energy_added_kwh: s.energy_added_kwh == null ? null : Number(s.energy_added_kwh),
    energy_used_kwh: s.energy_used_kwh == null ? null : Number(s.energy_used_kwh),
    cost_amount: s.cost_amount == null ? null : Number(s.cost_amount),
    rate_applied: s.rate_applied == null ? null : Number(s.rate_applied),
    miles_added_rated: s.miles_added_rated == null ? null : Number(s.miles_added_rated),
    start_range_mi: s.start_range_mi == null ? null : Number(s.start_range_mi),
    end_range_mi: s.end_range_mi == null ? null : Number(s.end_range_mi),
    outside_temp_avg: s.outside_temp_avg == null ? null : Number(s.outside_temp_avg),
    geofence_id: s.geofence_id == null ? null : Number(s.geofence_id),
  }))

  // Cluster per-VIN so two vehicles' sessions never merge across the seam.
  const byVin = new Map()
  for (const s of rows) {
    if (!byVin.has(s.vin)) byVin.set(s.vin, [])
    byVin.get(s.vin).push(s)
  }
  const merges = []
  for (const [, list] of byVin) merges.push(...planMerges(list, GAP_MS))

  log(`→ ${rows.length} closed${INCLUDE_SC ? '' : ' non-Supercharger'} sessions; ${merges.length} plug-ins to merge`)
  const absorbedTotal = merges.reduce((a, m) => a + m.absorbedIds.length, 0)
  log(`→ ${absorbedTotal + merges.length} rows collapse into ${merges.length} (net −${absorbedTotal})\n`)

  for (const m of merges) {
    log(`  survivor #${m.survivorId} ← absorb [${m.absorbedIds.join(', ')}]  →  ${r2(m.set.energy_added_kwh)} kWh, ${m.set.cost_currency ?? ''} ${r2(m.set.cost_amount)}, ${m.set.started_at ?? '(kept)'}…${m.set.ended_at} [${m.set.cost_source}]`)
  }

  if (!DRY && merges.length) {
    let merged = 0
    let deleted = 0
    let repointed = 0
    await tb.begin(async (tx) => {
      for (const m of merges) {
        const sc = m.set
        const rep = await tx`
          update vehicle_snapshot set source_charge_id = ${m.survivorId}
          where user_id = ${userId} and source_charge_id = any(${m.absorbedIds})`
        repointed += rep.count ?? 0
        await tx`
          update charge_session set
            ended_at = ${sc.ended_at}, energy_added_kwh = ${sc.energy_added_kwh},
            energy_used_kwh = ${sc.energy_used_kwh}, cost_amount = ${sc.cost_amount},
            cost_currency = ${sc.cost_currency}, cost_source = ${sc.cost_source},
            rate_applied = ${sc.rate_applied}, miles_added_rated = ${sc.miles_added_rated},
            start_battery_level = ${sc.start_battery_level}, end_battery_level = ${sc.end_battery_level},
            start_range_mi = ${sc.start_range_mi}, end_range_mi = ${sc.end_range_mi},
            outside_temp_avg = ${sc.outside_temp_avg}, geofence_id = ${sc.geofence_id},
            updated_at = now()
          where id = ${m.survivorId} and user_id = ${userId}`
        merged++
        const del = await tx`
          delete from charge_session where user_id = ${userId} and id = any(${m.absorbedIds})`
        deleted += del.count ?? 0
      }
    })
    log(`\n✓ merged ${merged} plug-ins, deleted ${deleted} absorbed rows, repointed ${repointed} snapshots`)
  } else {
    log(DRY ? '\n(dry run — nothing written)' : '\nnothing to merge')
  }
} catch (e) {
  console.error('\n✗ merge failed:', e.message)
  process.exitCode = 1
} finally {
  await tb.end({ timeout: 5 })
}
