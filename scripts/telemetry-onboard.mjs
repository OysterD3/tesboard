/**
 * ONE-TIME Fleet Telemetry onboarding CLI (`pnpm telemetry:onboard`).
 *
 * Configures a vehicle to stream Fleet Telemetry to a self-hosted Go fleet-telemetry
 * server (the `telemetry` INGEST_MODE path). This is the VM/CLI-side onboarding and is
 * the opt-in heavyweight alternative to the default polling mode — it requires the
 * virtual-key + mTLS-server setup that read-only polling deliberately avoids.
 *
 * Spec: docs/specs/2026-06-21-fleet-telemetry-dual-mode.spec.md §6 (exact sequence +
 * the fleet_telemetry_config body + the 24-field set). Reuses tesla-register.mjs's
 * partner-token + partner_accounts + resolve() flag/env pattern + public-key precheck.
 *
 * Sequence (idempotent):
 *   1. Partner token (client_credentials, documented scopes + audience).
 *   2. POST {base}/api/1/partner_accounts {domain}  (idempotent; ignore "already registered").
 *   3. Print the virtual-key deep link + pairing instructions (manual owner approval).
 *   4. Push the SIGNED fleet_telemetry_config via POST {proxy}/api/1/vehicles/fleet_telemetry_config.
 *      ⚠️ The config push MUST be SIGNED — it goes THROUGH a locally-running
 *         `tesla-http-proxy -key-file <TESLA_PRIVATE_KEY_PEM>` which signs the request.
 *         --proxy points at that proxy (default https://localhost:4443). The partner/
 *         registration calls (steps 1–2) and the verify GET (step 5) go to the real
 *         Fleet API base (--base), which is unsigned.
 *   5. GET {base}/api/1/vehicles/{vin}/fleet_telemetry_config — poll until synced && key_paired.
 *   6. --delete => DELETE the config (teardown / re-push after a billing-limit purge).
 *
 * ⚠️ OPEN RISK (spec §11): the exact create-endpoint body below is corroborated from the
 *    Tessie mirror + fleet-telemetry README but was NOT pulled from the canonical Tesla
 *    page (Cloudflare blocks the fetch). VERIFY THE BODY IN A BROWSER against
 *    developer.tesla.com before the first LIVE push. Run with --dry-run first.
 *
 * ⚠️ The previously-exposed TESLA_CLIENT_SECRET must be ROTATED before any onboarding.
 *
 * Usage:
 *   pnpm telemetry:onboard --vin <VIN> --hostname <fleet-telemetry FQDN> \
 *     --ca-file <server-tls-chain.pem> --domain <public-host> [--base <fleetUrl>] \
 *     [--proxy https://localhost:4443] [--dry-run]
 *   pnpm telemetry:onboard --vin <VIN> --base <fleetUrl> --delete       # teardown
 *   pnpm telemetry:onboard --help
 *
 * Creds (TESLA_CLIENT_ID/SECRET, TESLA_PRIVATE_KEY_PEM, TESLA_APP_DOMAIN, base URL) are
 * resolved env → .dev.vars → .env. Run it in YOUR terminal so the secret never hits chat.
 */
import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import postgres from 'postgres'

// ── flag + env resolution (same pattern as tesla-register.mjs) ──────────────
function flag(name) {
  const args = process.argv.slice(2)
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = args.indexOf(`--${name}`)
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return undefined
}
function bool(name) {
  return process.argv.slice(2).includes(`--${name}`)
}

function loadFromFile(path, key) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    /* file may not exist */
  }
  return undefined
}
function resolve(key) {
  return (
    process.env[key] || loadFromFile('.dev.vars', key) || loadFromFile('.env', key) || ''
  )
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

const TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token'
const SCOPES =
  'openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds'
const DEFAULT_PROXY = 'https://localhost:4443'

// ── the 24-field telemetry set (spec §4 / §6) — field → {interval_seconds} ──
// Order/values mirror spec §6 exactly. Each fires on-change, capped by interval.
const TELEMETRY_FIELDS = {
  Location: { interval_seconds: 10 },
  VehicleSpeed: { interval_seconds: 10 },
  Gear: { interval_seconds: 1 },
  Odometer: { interval_seconds: 60 },
  Soc: { interval_seconds: 60 },
  BatteryLevel: { interval_seconds: 60 },
  RatedRange: { interval_seconds: 60 },
  EstBatteryRange: { interval_seconds: 600 },
  OutsideTemp: { interval_seconds: 60 },
  InsideTemp: { interval_seconds: 600 },
  DetailedChargeState: { interval_seconds: 30 },
  ACChargingPower: { interval_seconds: 30 },
  DCChargingPower: { interval_seconds: 30 },
  ChargerVoltage: { interval_seconds: 30 },
  ChargeAmps: { interval_seconds: 30 },
  ChargerPhases: { interval_seconds: 300 },
  ACChargingEnergyIn: { interval_seconds: 30 },
  DCChargingEnergyIn: { interval_seconds: 30 },
  SentryMode: { interval_seconds: 600 },
  PreconditioningEnabled: { interval_seconds: 600 },
  HvacPower: { interval_seconds: 600 },
  PackVoltage: { interval_seconds: 30 },
  PackCurrent: { interval_seconds: 30 },
}
// (23 distinct proto fields above; spec's "24-field set" counts AC+DC variants —
//  ACChargingPower/DCChargingPower + ACChargingEnergyIn/DCChargingEnergyIn — as the
//  pairs that the adapter coalesces into the single charger_power / charge_energy_added
//  columns. This object is the exact `config.fields` map from spec §6.)

const HELP = `
Fleet Telemetry onboarding (one-time, VM/CLI-side)

  pnpm telemetry:onboard --vin <VIN> --hostname <fqdn> --ca-file <chain.pem> \\
    --domain <public-host> [--base <fleetUrl>] [--proxy <url>] [--dry-run]

  pnpm telemetry:onboard --vin <VIN> [--base <fleetUrl>] [--proxy <url>] --delete
  pnpm telemetry:onboard --help

Flags:
  --vin        Vehicle VIN to configure (required)
  --hostname   fleet-telemetry server FQDN the car connects to (required for push)
  --ca-file    PEM file: full chain of the server's TLS cert (required for push)
  --domain     Your PUBLIC app domain (hosts the 3p public key); default TESLA_APP_DOMAIN
  --base       Fleet API base URL; default TESLA_OAUTH_AUDIENCE / TESLA_FLEET_BASE_URL
  --proxy      tesla-http-proxy base that SIGNS the config push; default ${DEFAULT_PROXY}
  --delete     Teardown: DELETE the vehicle's fleet_telemetry_config, then exit
  --dry-run    Print every planned request (no network writes); private key NOT required

Creds resolved env -> .dev.vars -> .env:
  TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, TESLA_APP_DOMAIN, TESLA_PRIVATE_KEY_PEM (push only).

The config push goes THROUGH a locally-running, key-loaded tesla-http-proxy:
  tesla-http-proxy -key-file <TESLA_PRIVATE_KEY_PEM> -port 4443 ...
which signs the request. Point --proxy at it. Partner registration + verify use --base.
`

if (bool('help') || process.argv.slice(2).length === 0) {
  console.log(HELP)
  process.exit(0)
}

// ── inputs ──────────────────────────────────────────────────────────────────
const dryRun = bool('dry-run')
const doDelete = bool('delete')
const vin = flag('vin')
const hostname = flag('hostname')
const caFile = flag('ca-file')
const proxyBase = (flag('proxy') || DEFAULT_PROXY).replace(/\/+$/, '')

const clientId = resolve('TESLA_CLIENT_ID')
const clientSecret = resolve('TESLA_CLIENT_SECRET')
const domain = flag('domain') || resolve('TESLA_APP_DOMAIN')
const baseUrl = (
  flag('base') ||
  resolve('TESLA_OAUTH_AUDIENCE') ||
  resolve('TESLA_FLEET_BASE_URL') ||
  ''
).replace(/\/+$/, '')

if (!vin) fail('Missing --vin (the VIN to configure).')
if (!clientId || !clientSecret) {
  fail('Missing TESLA_CLIENT_ID or TESLA_CLIENT_SECRET (checked env, .dev.vars, .env).')
}
if (!baseUrl) {
  fail('Missing Fleet API base URL (TESLA_OAUTH_AUDIENCE / TESLA_FLEET_BASE_URL, or --base).')
}

// Validate domain only when we need it (registration / deep-link). Not needed for --delete.
function requirePublicDomain() {
  if (!domain || domain === 'localhost' || domain.startsWith('127.') || domain.includes(':')) {
    fail(
      `--domain / TESLA_APP_DOMAIN must be your public deployed hostname (got: "${domain || '<empty>'}").\n` +
        '  Tesla fetches the hosted 3p public key over HTTPS during pairing — localhost will not work.',
    )
  }
}

// Allow self-signed proxy cert (tesla-http-proxy commonly runs with a local cert).
// Only relax for the proxy push, restore for everything else by scoping per-fetch.
function proxyFetch(url, init) {
  // The push is to localhost; tesla-http-proxy may use a self-signed cert. We do NOT
  // disable verification globally — only the user can decide via NODE_TLS_REJECT_UNAUTHORIZED
  // if their proxy cert isn't trusted. Documented in the error hint below.
  return fetch(url, init)
}

console.log('Fleet Telemetry onboarding')
console.log(`  VIN        : ${vin}`)
console.log(`  base URL   : ${baseUrl}`)
console.log(`  proxy      : ${proxyBase}  (signs the config push)`)
if (!doDelete) {
  console.log(`  hostname   : ${hostname || '<none — required for push>'}`)
  console.log(`  ca-file    : ${caFile || '<none — required for push>'}`)
  console.log(`  app domain : ${domain || '<none>'}`)
}
if (dryRun) console.log('  MODE       : DRY RUN (no network writes)')
console.log('')

// ── helpers ───────────────────────────────────────────────────────────────
function printPlanned(label, method, url, body) {
  console.log(`  [dry-run] ${label}`)
  console.log(`            ${method} ${url}`)
  if (body !== undefined) {
    const s = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    console.log(s.split('\n').map((l) => '            ' + l).join('\n'))
  }
  console.log('')
}

async function getPartnerToken() {
  console.log('• Requesting a partner token…')
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPES,
    audience: baseUrl,
  })
  if (dryRun) {
    printPlanned('partner token', 'POST', TOKEN_URL, '<form: grant_type=client_credentials …>')
    return 'DRY_RUN_TOKEN'
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    fail(
      `Partner token request failed: HTTP ${res.status}\n  ${text}\n` +
        '  401/invalid_client usually means a wrong/rotated client secret.',
    )
  }
  const token = JSON.parse(text).access_token
  if (!token) fail(`Partner token response had no access_token:\n  ${text}`)
  console.log('  ✓ got partner token\n')
  return token
}

/** AES-256-GCM decrypt — mirrors src/server/tesla/crypto.ts: base64(iv12||tag16||ct). */
function decryptToken(payloadB64, keyB64) {
  const keyBuf = Buffer.from(keyB64, 'base64')
  if (keyBuf.length !== 32) fail('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.')
  const buf = Buffer.from(payloadB64, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const d = createDecipheriv('aes-256-gcm', keyBuf, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

/**
 * Read + decrypt the stored Tesla USER access token from the DB. The config
 * push/get/delete are VEHICLE endpoints — they need the vehicle owner's user
 * token, NOT the partner (client_credentials) token (which has no vehicles, so
 * Tesla returns "VIN not_found"). Single-user app → the one tesla_token row.
 * Read-only: we never refresh here, so the app's refresh-token chain is untouched.
 */
async function getUserAccessToken() {
  if (dryRun) return 'DRY_RUN_USER_TOKEN'
  const conn = resolve('DIRECT_URL') || resolve('DATABASE_URL')
  const encKey = resolve('TOKEN_ENCRYPTION_KEY')
  if (!conn) fail('Need DIRECT_URL or DATABASE_URL (Supabase :5432) to read the stored user token.')
  if (!encKey) fail('Need TOKEN_ENCRYPTION_KEY (env/.dev.vars) to decrypt the stored user token.')
  console.log('• Reading the stored Tesla USER token from the DB…')
  const sql = postgres(conn, { ssl: 'require', prepare: false, max: 1, idle_timeout: 5 })
  try {
    const rows = await sql`
      select access_token_enc, access_token_expires_at from tesla_token limit 1`
    if (!rows.length) {
      fail(
        'No Tesla token in the DB. Link your Tesla account first: log in to the dashboard,\n' +
          '  then visit https://' + (domain || 'YOUR_DOMAIN') + '/api/auth/tesla/login',
      )
    }
    let userToken
    try {
      userToken = decryptToken(rows[0].access_token_enc, encKey)
    } catch (e) {
      fail(`Could not decrypt the stored token (${e.message}). Is TOKEN_ENCRYPTION_KEY the one prod uses?`)
    }
    const exp = new Date(rows[0].access_token_expires_at).getTime()
    if (Number.isFinite(exp) && exp < Date.now()) {
      console.log('  ⚠ stored access token looks EXPIRED — open the dashboard once to refresh it, then retry.')
    }
    console.log('  ✓ got user token\n')
    return userToken
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function registerPartner(token) {
  requirePublicDomain()
  const keyUrl = `https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`
  console.log('• Checking the hosted public key is reachable…')
  if (dryRun) {
    printPlanned('public-key precheck', 'GET', keyUrl)
  } else {
    try {
      const k = await fetch(keyUrl)
      const text = await k.text()
      if (!k.ok) {
        fail(
          `The public key URL returned HTTP ${k.status}. Tesla must be able to fetch it.\n` +
            '  Make sure the app is deployed and serving public/.well-known/... at that domain.',
        )
      }
      if (!text.includes('BEGIN PUBLIC KEY') && !text.includes('BEGIN EC PUBLIC KEY')) {
        fail(`The public key URL is reachable but did not return a PEM public key.\n  Got: ${text.slice(0, 120)}…`)
      }
      console.log('  ✓ public key reachable\n')
    } catch (e) {
      fail(`Could not reach the public key URL (${e.message}). Is the app deployed at ${domain}?`)
    }
  }

  const url = `${baseUrl}/api/1/partner_accounts`
  console.log('• Registering partner account (idempotent)…')
  if (dryRun) {
    printPlanned('partner_accounts', 'POST', url, { domain })
    return
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  })
  const text = await res.text()
  if (!res.ok) {
    // Already-registered is fine (idempotent); only hard-fail on real errors.
    if (/already/i.test(text)) {
      console.log('  ✓ already registered\n')
      return
    }
    fail(
      `Partner registration failed: HTTP ${res.status}\n  ${text}\n` +
        '  412 → Tesla could not verify the hosted key (domain/key unreachable, or wrong region base URL).\n' +
        '  403 → the base URL may be the wrong region for your Tesla account.',
    )
  }
  console.log('  ✓ registered\n')
}

function printPairingInstructions() {
  requirePublicDomain()
  const deepLink = `https://tesla.com/_ak/${domain}?vin=${encodeURIComponent(vin)}`
  console.log('• Virtual-key pairing (manual — cannot be automated):')
  console.log(`    Open this deep link on the phone signed into the Tesla app for the car:`)
  console.log(`      ${deepLink}`)
  console.log('    Approve "Add Virtual Key". Requires firmware ≥ 2023.20.6 and Tesla app v4.27.3+.')
  console.log('    Step 5 below polls fleet_telemetry_config until key_paired:true.\n')
}

function buildTelemetryConfigBody() {
  if (!hostname) fail('Missing --hostname (the fleet-telemetry server FQDN) for the config push.')
  if (!caFile) fail('Missing --ca-file (PEM chain of the server TLS cert) for the config push.')
  let ca
  try {
    ca = readFileSync(caFile, 'utf8')
  } catch (e) {
    fail(`Could not read --ca-file "${caFile}": ${e.message}`)
  }
  if (!ca.includes('BEGIN CERTIFICATE')) {
    fail(`--ca-file "${caFile}" does not look like a PEM certificate chain (no BEGIN CERTIFICATE).`)
  }
  const exp = Math.floor(Date.now() / 1000) + 350 * 24 * 60 * 60 // now + 350d (Tesla caps exp at ~now+364d; stay safely under)
  // EXACT body from spec §6. ⚠️ Verify against developer.tesla.com in a browser before
  // first LIVE push (open risk: corroborated from Tessie mirror + README, not canonical).
  return {
    vins: [vin],
    config: {
      hostname,
      port: 443,
      ca,
      exp,
      fields: TELEMETRY_FIELDS,
      alert_types: ['service'],
      prefer_typed: true,
    },
  }
}

async function pushConfig(body, token) {
  // Goes THROUGH the local tesla-http-proxy, which SIGNS the request with the private key.
  // The proxy is transparent for AUTH (it only adds the command signature), so we must
  // still send the OAuth Bearer token — the proxy forwards it to the Fleet API.
  const url = `${proxyBase}/api/1/vehicles/fleet_telemetry_config`
  console.log('• Pushing fleet_telemetry_config (SIGNED, via tesla-http-proxy)…')
  if (dryRun) {
    printPlanned('fleet_telemetry_config push', 'POST', url, body)
    console.log('  (dry-run: TESLA_PRIVATE_KEY_PEM not required; the running proxy signs the real push.)\n')
    return
  }
  // The proxy needs the key loaded; warn early if it isn't even present locally.
  if (!resolve('TESLA_PRIVATE_KEY_PEM')) {
    fail(
      'TESLA_PRIVATE_KEY_PEM is not set (env/.dev.vars/.env). The config push must be SIGNED.\n' +
        '  Start the signer:  tesla-http-proxy -key-file <your-private-key.pem> -port 4443 …\n' +
        '  then point --proxy at it. (Use --dry-run to preview without the key.)',
    )
  }
  let res
  try {
    res = await proxyFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    fail(
      `Could not reach the signing proxy at ${proxyBase} (${e.message}).\n` +
        '  Is `tesla-http-proxy -key-file <pem>` running there?\n' +
        '  If it uses a self-signed cert, run with NODE_TLS_REJECT_UNAUTHORIZED=0 (localhost only).',
    )
  }
  const text = await res.text()
  if (!res.ok) {
    fail(
      `Config push failed: HTTP ${res.status}\n  ${text}\n` +
        '  Common causes: virtual key not paired yet (do step 3), wrong CA chain, or expired exp.',
    )
  }
  console.log('  ✓ config pushed\n  Response:', text, '\n')
}

async function getConfig(token) {
  const url = `${baseUrl}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GET fleet_telemetry_config failed: HTTP ${res.status}\n  ${text}`)
  }
  return JSON.parse(text)
}

async function verifyConfig(token) {
  const url = `${baseUrl}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`
  console.log('• Verifying config (poll until synced && key_paired)…')
  if (dryRun) {
    printPlanned('verify', 'GET', url)
    return
  }
  const deadline = Date.now() + 5 * 60 * 1000 // up to 5 min for the owner to approve
  let last
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    let parsed
    try {
      parsed = await getConfig(token)
    } catch (e) {
      fail(e.message)
    }
    const r = parsed.response ?? parsed
    last = r
    const synced = r?.synced === true
    const paired = r?.key_paired === true
    console.log(`    attempt ${attempt}: synced=${r?.synced} key_paired=${r?.key_paired}`)
    if (synced && paired) {
      console.log('\n  ✓ telemetry config is synced and key-paired — streaming should begin.\n')
      return
    }
    if (synced && !paired) {
      console.log('    synced but NOT key_paired → the deep-link pairing was skipped; re-do step 3.')
    }
    // wait 15s between polls
    await new Promise((res) => setTimeout(res, 15000))
  }
  fail(
    `Timed out waiting for synced && key_paired.\n  Last response: ${JSON.stringify(last)}\n` +
      '  If key_paired is false, complete the virtual-key deep link, then re-run --dry-run-free verify.',
  )
}

async function deleteConfig(token) {
  const url = `${baseUrl}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`
  console.log('• Deleting fleet_telemetry_config (teardown)…')
  if (dryRun) {
    printPlanned('delete', 'DELETE', url)
    return
  }
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) {
    fail(`Delete failed: HTTP ${res.status}\n  ${text}`)
  }
  console.log('  ✓ config deleted\n  Response:', text, '\n')
}

// ── main ────────────────────────────────────────────────────────────────────
const token = await getPartnerToken()

if (doDelete) {
  const userToken = await getUserAccessToken()
  await deleteConfig(userToken)
  console.log('✓ Teardown complete for', vin)
  process.exit(0)
}

await registerPartner(token)
printPairingInstructions()

// Vehicle endpoints (push/verify) need the USER token, not the partner token.
const userToken = await getUserAccessToken()
const configBody = buildTelemetryConfigBody()
await pushConfig(configBody, userToken)
await verifyConfig(userToken)

console.log('✓ Telemetry onboarding complete for', vin)
console.log('  Next: bring up telemetry/docker-compose.yml (fleet-telemetry + mosquitto + adapter)')
console.log('  and set INGEST_MODE=telemetry so the CF poll cron no-ops.')
