/**
 * Register this app as a Tesla Fleet API partner: POST /api/1/partner_accounts.
 *
 * This is REQUIRED even for a read-only app — every Fleet API data call returns
 * 412 until it's done. It only needs to run ONCE per region (per Tesla app).
 *
 * Tesla verifies registration by fetching your hosted public key at
 *   https://<TESLA_APP_DOMAIN>/.well-known/appspecific/com.tesla.3p.public-key.pem
 * so TESLA_APP_DOMAIN must be your PUBLIC, deployed domain (NOT localhost) and the
 * app must be live there serving that key. Deploy first, then run this.
 *
 * Usage:
 *   pnpm tesla:register --domain=<your-public-host>      # e.g. tesboard.YOUR_SUBDOMAIN.workers.dev
 *   pnpm tesla:register --domain=<host> --base=<fleetUrl> # override the regional base URL too
 *
 * --domain overrides TESLA_APP_DOMAIN (your .dev.vars likely has `localhost` for
 * local OAuth, which Tesla can't reach). --base overrides TESLA_OAUTH_AUDIENCE /
 * TESLA_FLEET_BASE_URL. Everything else (TESLA_CLIENT_ID/SECRET) is read from the
 * environment, then .dev.vars, then .env. Run it in YOUR terminal so the client
 * secret never goes through chat.
 */
import { readFileSync } from 'node:fs'

/** Parse `--key=value` / `--key value` flags from argv. */
function flag(name) {
  const args = process.argv.slice(2)
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = args.indexOf(`--${name}`)
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return undefined
}

const TOKEN_URL = 'https://auth.tesla.com/oauth2/v3/token'
const SCOPES =
  'openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds'

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

const clientId = resolve('TESLA_CLIENT_ID')
const clientSecret = resolve('TESLA_CLIENT_SECRET')
const domain = flag('domain') || resolve('TESLA_APP_DOMAIN')
const baseUrl =
  flag('base') || resolve('TESLA_OAUTH_AUDIENCE') || resolve('TESLA_FLEET_BASE_URL')

if (!clientId || !clientSecret) {
  fail('Missing TESLA_CLIENT_ID or TESLA_CLIENT_SECRET (checked env, .dev.vars, .env).')
}
if (!domain || domain === 'localhost' || domain.startsWith('127.') || domain.includes(':')) {
  fail(
    `TESLA_APP_DOMAIN must be your public deployed hostname (got: "${domain || '<empty>'}").\n` +
      '  Tesla fetches the hosted key over HTTPS during registration — localhost will not work.\n' +
      '  Deploy to Cloudflare first, then set TESLA_APP_DOMAIN to e.g. tesboard.YOUR_SUBDOMAIN.workers.dev.',
  )
}
if (!baseUrl) {
  fail('Missing regional base URL (TESLA_OAUTH_AUDIENCE / TESLA_FLEET_BASE_URL, or pass one as an arg).')
}

const keyUrl = `https://${domain}/.well-known/appspecific/com.tesla.3p.public-key.pem`

console.log('Tesla partner registration')
console.log(`  app domain : ${domain}`)
console.log(`  base URL   : ${baseUrl}`)
console.log(`  public key : ${keyUrl}\n`)

// 0) Pre-check that Tesla will be able to fetch the hosted public key.
console.log('• Checking the hosted public key is reachable…')
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

// 1) Partner (client_credentials) token.
console.log('• Requesting a partner token…')
const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: SCOPES,
    audience: baseUrl,
  }),
})
const tokenBody = await tokenRes.text()
if (!tokenRes.ok) {
  fail(
    `Partner token request failed: HTTP ${tokenRes.status}\n  ${tokenBody}\n` +
      '  401/invalid_client usually means a wrong/rotated client secret.',
  )
}
const accessToken = JSON.parse(tokenBody).access_token
if (!accessToken) fail(`Partner token response had no access_token:\n  ${tokenBody}`)
console.log('  ✓ got partner token\n')

// 2) Register the partner account for this domain.
console.log('• Registering partner account…')
const regRes = await fetch(`${baseUrl}/api/1/partner_accounts`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ domain }),
})
const regBody = await regRes.text()

if (!regRes.ok) {
  fail(
    `Registration failed: HTTP ${regRes.status}\n  ${regBody}\n` +
      '  412 → Tesla could not verify the hosted key (domain/key not reachable, or wrong region base URL).\n' +
      '  403 → the base URL may be the wrong region for your Tesla account.',
  )
}

console.log('  ✓ registered\n')
console.log('✓ Partner registration complete for', domain)
console.log('  Response:', regBody)
console.log('\nNext: open the dashboard and click “Sync from Tesla” — your vehicle should appear.')
