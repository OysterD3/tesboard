# tesboard Fleet Telemetry stack

Self-hosted, **opt-in** ingest path for `INGEST_MODE=telemetry`. The car opens a persistent
mTLS WebSocket to Tesla's prebuilt fleet-telemetry server, which forwards decoded records to a
co-located MQTT broker; a Node adapter coalesces sparse delta signals into full snapshots and
writes them to Supabase over a **direct** session-pooler connection (`:5432`, not Hyperdrive).

This directory is **not** bundled by the Cloudflare Worker. It runs on its own VM (Aliyun
Singapore in our setup). In telemetry mode the CF poll cron no-ops; reconcile + UI are unchanged.

## Containers (`docker-compose.yml`)

1. **fleet-telemetry** — Tesla's **prebuilt** `tesla/fleet-telemetry` image (pin a real tag from
   hub.docker.com; the compose file ships a clearly-marked PLACEHOLDER). **Not forked / not vendored** —
   we run Tesla's image as-is. Only port **443** is published (mTLS from the car).
2. **mosquitto** — `eclipse-mosquitto:2`. No published port; broker lives on the internal compose
   network (loopback-equivalent).
3. **adapter** — built from `./adapter`; reads from MQTT, writes snapshots/sessions to Supabase.

## Setup

Certificates go in `./certs/server/` (`tls.crt` + `tls.key`) and are gitignored. Copy
`adapter/.env.example` to `adapter/.env` and fill in `DIRECT_URL`.

Full walkthrough (VM provisioning, DNS/FQDN, TLS cert, virtual-key + mTLS onboarding, pinning the
image tag): **`docs/guides/telemetry-aliyun-sg-setup.md`**.
