/**
 * Reconcile QuickCharge charging-operator receipts → tesboard (Supabase) Postgres.
 *
 * QuickCharge (Malaysian AC charging app) issues one authoritative receipt per
 * plug-in: RM cost + grid-side meter kWh. tesboard's poller / Tessie+TeslaMate
 * importers split each plug-in into several charge_session rows, so one receipt
 * usually maps to N same-day sessions. This script:
 *   1. loads the receipts from a JSON file (scripts/quickcharge/receipts.json),
 *   2. pulls the car's non-Supercharger sessions over the receipts' date range,
 *   3. runs the pure matcher (./quickcharge/reconcile.mjs) to produce a plan:
 *        - applies  : per-session authoritative cost + grid-energy (proportional)
 *        - inserts  : standalone gap rows for receipts with no session
 *        - review   : suspicious matches it WON'T auto-apply (you decide)
 *        - excluded : corrupt sessions dropped from matching (e.g. 42-day rows)
 *   4. applies it idempotently (cost_source 'quickcharge', frozen by reclassify).
 *
 * Writes via the DIRECT (session, :5432) connection — same as db:migrate / the
 * other importers, NOT Hyperdrive/6543.
 *
 * Usage:
 *   pnpm import:quickcharge <tesboard-user-email> [options]
 *
 * Options:
 *   --dry-run             plan + print, write NOTHING (do this first)
 *   --receipts=<path>     receipts JSON (default scripts/quickcharge/receipts.json)
 *   --utc-offset=<min>    local minutes east of UTC for receipt dates (default 480 = UTC+8)
 *   --assumed-kw=<kw>     AC power used to estimate gap-row duration (default 7)
 *   --date-pad=<days>     widen the session fetch window around receipts (default 2)
 */
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { reconcile } from './quickcharge/reconcile.mjs'

// ── env + args ───────────────────────────────────────────────────────────────
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
const positionals = argv.filter((a) => !a.startsWith('--'))
const email = positionals[0]
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}

if (!email) {
  console.error('Usage: node scripts/import-quickcharge.mjs <tesboard-user-email> [--dry-run] [--receipts=path] [--utc-offset=480]')
  process.exit(1)
}

const DRY = flag('dry-run')
const RECEIPTS_PATH = opt('receipts', 'scripts/quickcharge/receipts.json')
const OFFSET_MIN = Number(opt('utc-offset', '480'))
const ASSUMED_KW = Number(opt('assumed-kw', '7'))
const DATE_PAD_DAYS = Number(opt('date-pad', '2'))

const TB_URL = resolve('DIRECT_URL') || resolve('DATABASE_URL')
if (!TB_URL) {
  console.error('Missing DIRECT_URL / DATABASE_URL (use the :5432 session URL, not the 6543 pooler).')
  process.exit(1)
}

// ── load receipts ──────────────────────────────────────────────────────────
let doc
try {
  doc = JSON.parse(readFileSync(RECEIPTS_PATH, 'utf8'))
} catch (e) {
  console.error(`Cannot read receipts file ${RECEIPTS_PATH}: ${e.message}`)
  process.exit(1)
}
const VIN = doc.vin
const CURRENCY = doc.currency || 'MYR'
const GEOFENCE_NAME = doc.geofence || null
const receipts = (doc.receipts ?? []).filter((r) => r && r.date && r.usageKwh != null && r.spent != null)
if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(VIN || '')) {
  console.error(`receipts.json "vin" (${VIN}) is not a 17-char VIN.`)
  process.exit(1)
}
if (!receipts.length) {
  console.error('No usable receipts in the JSON.')
  process.exit(1)
}

const dates = receipts.map((r) => r.date).sort()
const loDate = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - DATE_PAD_DAYS * 86_400_000).toISOString()
const hiDate = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + (DATE_PAD_DAYS + 1) * 86_400_000).toISOString()

const log = (...a) => console.log(...a)
const fmt = (n) => (n == null ? '—' : Number(n).toFixed(2))

const tb = postgres(TB_URL, { max: 3, prepare: false, idle_timeout: 20 })
let batchId = null

try {
  const [user] = await tb`select id from auth.users where email = ${email} limit 1`
  if (!user) throw new Error(`No tesboard user with email ${email}. Run pnpm user:create first.`)
  const userId = user.id
  log(`→ tesboard user ${email} = ${userId}`)
  log(`→ ${receipts.length} receipts ${dates[0]} … ${dates[dates.length - 1]} (VIN ${VIN}, ${CURRENCY}, UTC+${OFFSET_MIN / 60})`)

  // QuickCharge location geofence (optional — informs geofence_id + home/away).
  let geofence = null
  if (GEOFENCE_NAME) {
    const [gf] = await tb`
      select id, is_home from geofence where user_id = ${userId} and name = ${GEOFENCE_NAME} limit 1`
    geofence = gf ? { id: Number(gf.id), is_home: gf.is_home } : null
    if (!geofence) log(`  ⚠ geofence "${GEOFENCE_NAME}" not found — gap rows get null geofence_id, location 'away'`)
  }

  // Non-Supercharger sessions over the receipts' date span (+pad for overnight).
  //   ended_at is not null     → never touch an open/in-progress session (the live
  //                              poller owns it; durationS can't guard a null end).
  //   import_source<>'quickcharge' → don't re-ingest our OWN prior gap inserts as
  //                              phantom members on re-run (keeps re-runs idempotent).
  // Closed 'live' rows ARE eligible so a future receipt can match a poller-captured
  // session instead of duplicating it as a gap.
  const sessions = (
    await tb`
      select id, started_at, ended_at, energy_added_kwh, cost_source
      from charge_session
      where user_id = ${userId} and vin = ${VIN} and source <> 'supercharger'
        and ended_at is not null and import_source <> 'quickcharge'
        and started_at >= ${loDate} and started_at < ${hiDate}
      order by started_at`
  ).map((s) => ({
    id: Number(s.id),
    started_at: new Date(s.started_at).toISOString(),
    ended_at: s.ended_at ? new Date(s.ended_at).toISOString() : null,
    energy_added_kwh: s.energy_added_kwh == null ? null : Number(s.energy_added_kwh),
    cost_source: s.cost_source,
  }))
  log(`→ ${sessions.length} non-Supercharger sessions in window`)

  const plan = reconcile({ receipts, sessions, offsetMin: OFFSET_MIN, geofence, assumedKw: ASSUMED_KW })

  // ── report ──────────────────────────────────────────────────────────────
  log('\n── reconciliation plan ──')
  log(`  matched session updates : ${plan.applies.length}`)
  log(`  gap inserts             : ${plan.inserts.length}`)
  log(`  flagged for review      : ${plan.review.length}`)
  log(`  excluded (corrupt)      : ${plan.excluded.length}`)
  log(`  unclaimed sessions      : ${plan.unmatchedSessions.length}`)

  if (plan.inserts.length) {
    log('\n  gap inserts (no matching session):')
    for (const g of plan.inserts) log(`    #${g.receiptNo} ${g.started_at.slice(0, 10)} ${g.charger}  ${CURRENCY} ${fmt(g.cost_amount)} / ${fmt(g.energy_used_kwh)} kWh`)
  }
  if (plan.review.length) {
    log('\n  ⚠ REVIEW (not auto-applied):')
    for (const r of plan.review) log(`    #${r.receiptNo} ${r.date}: ${r.reason}\n        receipt ${fmt(r.receiptSpent)}/${fmt(r.receiptUsageKwh)}kWh vs sessions [${r.sessionIds.join(', ')}] added ${fmt(r.groupAddedKwh)}kWh`)
  }
  if (plan.excluded.length) {
    log('\n  excluded sessions (left untouched — fix separately):')
    for (const e of plan.excluded) log(`    id ${e.id} (receipt #${e.receiptNo}): ${e.reason}`)
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  if (!DRY) {
    const [b] = await tb`
      insert into import_batch (user_id, source, status)
      values (${userId}, 'quickcharge', 'running') returning id`
    batchId = b.id
    log(`\n→ import_batch #${batchId}`)

    const now = new Date().toISOString()
    let updated = 0
    let inserted = 0

    for (const a of plan.applies) {
      const invoices = tb.json({ quickcharge: { receiptNo: a.receiptNo } })
      await tb`
        update charge_session set
          cost_amount = ${a.cost_amount},
          cost_currency = ${CURRENCY},
          cost_source = 'quickcharge',
          rate_applied = ${a.rate_applied},
          energy_used_kwh = ${a.energy_used_kwh},
          geofence_id = coalesce(${a.geofence_id ?? null}, geofence_id),
          invoices = ${invoices},
          updated_at = ${now}
        where id = ${a.id} and user_id = ${userId}`
      updated++
    }

    for (const g of plan.inserts) {
      const invoices = tb.json({ quickcharge: { receiptNo: g.receiptNo, charger: g.charger, durationEstimated: true } })
      await tb`
        insert into charge_session (vin, user_id, source, started_at, ended_at,
          energy_added_kwh, energy_used_kwh, cost_amount, cost_currency, cost_source,
          rate_applied, geofence_id, charge_location_type, invoices, import_source, source_pk)
        values (${VIN}, ${userId}, 'home', ${g.started_at}, ${g.ended_at},
          ${g.energy_added_kwh}, ${g.energy_used_kwh}, ${g.cost_amount}, ${CURRENCY}, 'quickcharge',
          ${g.rate_applied}, ${g.geofence_id}, ${g.charge_location_type}, ${invoices}, 'quickcharge', ${Number(g.receiptNo)})
        on conflict (vin, started_at) where import_source <> 'live' do update set
          ended_at = excluded.ended_at, energy_used_kwh = excluded.energy_used_kwh,
          cost_amount = excluded.cost_amount, cost_currency = excluded.cost_currency,
          cost_source = excluded.cost_source, rate_applied = excluded.rate_applied,
          geofence_id = excluded.geofence_id, charge_location_type = excluded.charge_location_type,
          invoices = excluded.invoices, source_pk = excluded.source_pk, updated_at = ${now}`
      inserted++
    }

    const counts = { updated, inserted, review: plan.review.length, excluded: plan.excluded.length }
    await tb`update import_batch set status = 'completed', row_counts = ${tb.json(counts)},
      finished_at = now() where id = ${batchId}`
    log(`✓ applied: ${updated} session updates, ${inserted} gap inserts (batch #${batchId})`)
  } else {
    log('\n(dry run — nothing written)')
  }
} catch (e) {
  console.error('\n✗ reconcile failed:', e.message)
  if (batchId && !DRY) {
    try {
      await tb`update import_batch set status = 'failed', error = ${String(e.message)}, finished_at = now() where id = ${batchId}`
    } catch {
      /* best effort */
    }
  }
  process.exitCode = 1
} finally {
  await tb.end({ timeout: 5 })
}
