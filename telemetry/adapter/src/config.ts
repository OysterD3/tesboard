/**
 * Adapter configuration — read straight from `process.env` (this is plain Node on
 * a VM, NOT a Cloudflare Worker, so there is NO bindings/bridgeEnv layer). Load
 * `.env` once at boot (index.ts calls dotenv) before reading these.
 *
 * The adapter holds DIRECT DB creds that bypass RLS, so the only ownership guard
 * is per-(vin, user_id) scoping resolved from the trusted `vehicle` table — never
 * from the stream. See index.ts.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name]
  return v != null && v !== '' ? v : fallback
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export interface AdapterConfig {
  /** Supabase SESSION pooler (:5432) — NOT Hyperdrive, NOT the :6543 txn pooler. */
  directUrl: string
  /** mqtt broker URL; on the compose network this is the internal service host. */
  mqttUrl: string
  /** fleet-telemetry `topic_base` — topics are `{base}/{vin}/v/{Field}` + `{base}/{vin}/connectivity`. */
  topicBase: string
  /** Cadence (seconds) to flush a coalesced snapshot while the VIN is active (driving/charging). */
  flushIntervalActiveS: number
  /** Cadence (seconds) to flush while the VIN is idle (parked, only slow signals). */
  flushIntervalIdleS: number
  /** mqtt client id (must be unique per broker connection). */
  mqttClientId: string
}

/**
 * Build + validate the config. Throws if DIRECT_URL is missing — the adapter
 * cannot do anything useful without a DB to write to.
 */
export function loadConfig(): AdapterConfig {
  const directUrl = process.env.DIRECT_URL
  if (!directUrl || directUrl.trim() === '') {
    throw new Error(
      'DIRECT_URL is required (Supabase SESSION pooler :5432 — NOT Hyperdrive, NOT :6543).',
    )
  }
  // The :6543 transaction pooler tears down connections per-transaction; a long-lived
  // client over it churns connections (the same footgun called out for Hyperdrive).
  // Warn rather than refuse, so an operator who knows their setup isn't hard-blocked.
  if (directUrl.includes(':6543')) {
    console.warn(
      '[adapter] DIRECT_URL points at the :6543 transaction pooler — use the :5432 SESSION pooler. ' +
        'The transaction pooler is unsuitable for a long-lived connection and will churn.',
    )
  }
  return {
    directUrl,
    mqttUrl: str('MQTT_URL', 'tcp://mosquitto:1883'),
    topicBase: str('TOPIC_BASE', 'tesla'),
    flushIntervalActiveS: num('FLUSH_INTERVAL_ACTIVE_S', 20),
    flushIntervalIdleS: num('FLUSH_INTERVAL_IDLE_S', 60),
    mqttClientId: str('MQTT_CLIENT_ID', 'tesboard-telemetry-adapter'),
  }
}
