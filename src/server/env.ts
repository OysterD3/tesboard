/**
 * Server-only environment access.
 *
 * Every value here is read from `process.env` at CALL TIME (inside a function),
 * never at module scope, so the values are resolved per-request on the server
 * and are never captured into a client bundle. Do NOT import this from a file
 * that runs on the client — these names have no `VITE_` prefix on purpose.
 */

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    )
  }
  return value
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function numOr(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const serverEnv = {
  tesla: () => ({
    clientId: required('TESLA_CLIENT_ID'),
    clientSecret: required('TESLA_CLIENT_SECRET'),
    redirectUri: required('TESLA_REDIRECT_URI'),
    appDomain: required('TESLA_APP_DOMAIN'),
    fleetBaseUrl: required('TESLA_FLEET_BASE_URL'),
    oauthAudience: optional('TESLA_OAUTH_AUDIENCE', required('TESLA_FLEET_BASE_URL')),
    privateKeyPem: optional('TESLA_PRIVATE_KEY_PEM'),
  }),
  app: () => ({
    origin: required('APP_ORIGIN'),
    tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),
    cronTriggerSecret: required('CRON_TRIGGER_SECRET'),
  }),
  // Public Supabase config (url + anon key) — all the user-scoped client needs.
  // Deliberately does NOT require the service-role key, so the login/dashboard
  // pages work before the (secret) service-role key is configured.
  supabase: () => {
    const url = required('SUPABASE_URL')
    const anonKey = required('SUPABASE_ANON_KEY')
    // The @supabase/ssr session cookie name is derived from the project ref in
    // the URL host. If the browser (VITE_*) and server URLs point at different
    // projects, the server reads a different cookie name than the browser wrote
    // and auth silently fails (endless /login loop). Fail fast instead.
    const viteUrl = process.env.VITE_SUPABASE_URL
    if (viteUrl && new URL(viteUrl).host !== new URL(url).host) {
      throw new Error(
        'SUPABASE_URL and VITE_SUPABASE_URL point at different projects — ' +
          'they must be the same Supabase project, or auth cookies will not match.',
      )
    }
    return { url, anonKey }
  },
  // Direct Postgres access for Drizzle (postgres-js over the Supabase pooler).
  // The connection string carries the DB password — keep it server-only.
  database: () => ({ url: required('DATABASE_URL') }),
  // Mapbox access token for the Map Matching API (road-snapping drive routes).
  // Optional: null when unset, so the route-match backfill is simply unavailable
  // and the map keeps drawing raw straight-line breadcrumbs. Server-only secret.
  mapboxToken: (): string | null => process.env.MAPBOX_TOKEN || null,
  // Adaptive burst polling (the per-VIN Durable Object). OFF by default: when
  // disabled the cron poller behaves exactly as it always has. Set BURST_POLL=on
  // (a wrangler var) to enable ~20s/30s polling while driving/charging.
  burstPoll: () => ({
    enabled: optional('BURST_POLL', 'off').toLowerCase() === 'on',
    driveS: numOr('BURST_POLL_DRIVE_S', 20),
    chargeS: numOr('BURST_POLL_CHARGE_S', 30),
  }),
  // Ingest mode. 'polling' (default) = the CF poll cron reads vehicle_data and
  // sessionizes. 'telemetry' = the poll cron no-ops; a self-hosted Fleet
  // Telemetry adapter ingests instead (reusing the same sessionization). Reconcile
  // + UI run unchanged in both modes.
  ingestMode: (): 'polling' | 'telemetry' =>
    optional('INGEST_MODE', 'polling').toLowerCase() === 'telemetry' ? 'telemetry' : 'polling',
  // Idle-backoff: skip the billable vehicle_data read for an online-but-parked car
  // until `idleMin` minutes elapse, unless it was active within `graceMin`. The big
  // polling-cost saver. Default ON (set IDLE_BACKOFF=off to restore flat polling).
  idleBackoff: (): { enabled: boolean; idleMin: number; graceMin: number } => ({
    enabled: optional('IDLE_BACKOFF', 'on').toLowerCase() !== 'off',
    idleMin: numOr('IDLE_BACKOFF_MIN', 30),
    graceMin: numOr('ACTIVE_GRACE_MIN', 10),
  }),
}

/** Tesla's well-known OAuth endpoints (region-independent). */
export const TESLA_OAUTH = {
  authorize: 'https://auth.tesla.com/oauth2/v3/authorize',
  token: 'https://auth.tesla.com/oauth2/v3/token',
} as const

/**
 * OAuth scopes. `vehicle_charging_cmds` is required to READ /dx/charging/history
 * (authoritative Supercharger cost) — we never send commands, so this stays
 * functionally read-only and needs no virtual-key pairing.
 */
export const TESLA_SCOPES = [
  'openid',
  'offline_access',
  'vehicle_device_data',
  'vehicle_location',
  'vehicle_charging_cmds',
] as const
