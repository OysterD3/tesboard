# Telemetry setup (step by step)

This guide turns on **Telemetry mode**, where your Tesla streams data directly to a small
server you run, instead of tesboard polling Tesla's API. It cuts the Tesla bill to near
zero and gives ~10-second driving detail — at the cost of running a ~$4/mo server and a
one-time pairing process.

**Before you start, read [Choosing a mode](./choosing-a-mode.md).** If you have one car,
you almost certainly want Polling (free, no setup) and can ignore this entire page.

> **Skill level & time.** This is the advanced path. You'll use the terminal (SSH, Docker,
> a few commands). Budget **2–4 hours** the first time. Every command is copy-pasteable;
> when something goes wrong, the **[Troubleshooting](#troubleshooting)** section at the
> bottom lists every common error and its fix.

---

## What you're building

```
  Your Tesla ──(encrypted stream, port 443)──►  Streaming server  ┐
                                                  (Docker, on your VM)│
                                                                      ▼
                                                              Message broker
                                                              (Docker, internal)
                                                                      │
                                                                      ▼
                                                                Adapter (Docker)
                                                                      │
                                                                      ▼
                          Supabase database  ◄──────────────────────┘
                                  ▲
                                  │ reads
                          tesboard dashboard (Cloudflare — unchanged)
```

Three small Docker containers run on your VM: the **Tesla streaming server**, a **broker**,
and an **adapter** that writes to the same Supabase database your dashboard already reads.
**Your Cloudflare dashboard doesn't move — you're just adding a second writer.**

---

## Before you start — checklist

You should already have tesboard deployed and working in **Polling** mode:
- The dashboard is live at your domain (e.g. `https://dash.example.com`) and you can log in.
- You've linked your Tesla once and set your electricity rate.

You'll also need:
- A **domain** you control, on **Cloudflare DNS**.
- Your **Supabase database connection string** (the session-pooler URL, port **5432**).
- A **Tesla Developer account** with your app (developer.tesla.com).
- A credit card for the VM (~$4/mo) and ~2–4 hours.

> Throughout, replace these placeholders:
> - `<app-domain>` — your dashboard domain (e.g. `dash.example.com`)
> - `<telemetry-fqdn>` — a **new** subdomain for the streaming server (e.g. `stream.example.com`)
> - `<vm-ip>` — your VM's public IP
> - `<YOUR_VIN>` — your car's VIN

---

## Part 1 — Rent and prepare a VM

Pick a provider from the table in [Choosing a mode](./choosing-a-mode.md#your-side-the-server-telemetry-only).
Any small Linux VM works (1 vCPU, ~1 GB RAM, public IP, Ubuntu/Debian). Create it, then SSH in.

> 💡 **Log in as root** for setup, or prefix commands with `sudo`. If you see
> "Permission denied", run `sudo -i` to become root.

Install Docker and add a little swap (helps a 1 GB box):

```bash
# Docker
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable --now docker

# 1 GB swap (safe on a small VM)
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

**Open the firewall** — in BOTH your cloud provider's security group **and** the OS:
- **443** (the car connects here) — required, open to the world.
- **80** (temporary, for the certificate step) — open during Part 3.
- **22** (SSH) — restrict to **your own IP** if you can.

> Do **not** open any other ports. The broker and adapter stay private inside Docker.

---

## Part 2 — Point a subdomain at the VM (DNS)

In Cloudflare, for your zone, add an **A record**:
- **Name:** the subdomain part of `<telemetry-fqdn>` (e.g. `stream`)
- **IPv4 address:** `<vm-ip>`
- **Proxy status:** **DNS only (grey cloud)** — ⚠️ **this is critical.**

> **Why grey-cloud:** the car proves who it is with a **client certificate** (mutual TLS).
> If Cloudflare proxies the connection (orange cloud), it terminates TLS and the car's
> certificate never reaches your server, so the handshake fails. The connection must go
> **straight to your VM**. Your dashboard domain stays orange-clouded as normal — only
> this telemetry subdomain is grey.

---

## Part 3 — Get a TLS certificate for the streaming server

The streaming server needs its own certificate for `<telemetry-fqdn>`. Use Let's Encrypt:

```bash
# certbot is usually NOT preinstalled — install it first:
apt install -y certbot

# Issue the cert (needs port 80 reachable + nothing else using it; the streaming
# server uses 443, so 80 is free). DNS from Part 2 must already point here.
certbot certonly --standalone -d <telemetry-fqdn>
```

Then copy the certificate into the folder the stack expects, **renaming** to `tls.crt` /
`tls.key` (you'll create the `tesboard/telemetry` folder in Part 4 — do this after cloning,
or `mkdir -p` it now):

```bash
mkdir -p ~/tesboard/telemetry/certs/server
cp /etc/letsencrypt/live/<telemetry-fqdn>/fullchain.pem ~/tesboard/telemetry/certs/server/tls.crt
cp /etc/letsencrypt/live/<telemetry-fqdn>/privkey.pem   ~/tesboard/telemetry/certs/server/tls.key
chmod 600 ~/tesboard/telemetry/certs/server/tls.key
```

- `tls.crt` must be the **full chain** (`fullchain.pem`). You'll hand the *same* file to
  the onboarding tool later so your car trusts the server.
- Certs expire every 90 days — see [Operations](#operations) for renewal.

---

## Part 4 — Get the code on the VM and configure it

Clone the repository (the whole repo is needed — the adapter shares code with the app):

```bash
cd ~
git clone <your-tesboard-repo-url> tesboard
cd tesboard/telemetry
```

Create the adapter's environment file from the example and set your **database URL**:

```bash
cp adapter/.env.example adapter/.env
nano adapter/.env     # or any editor
```

Set `DIRECT_URL` to your **Supabase session pooler** connection string:

```dotenv
DIRECT_URL=postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres
```

> ⚠️ **Port 5432, the *session* pooler** — **not** `:6543` (the transaction pooler, which
> drops long-lived connections), and **not** a local TeslaMate database. It's the same URL
> you use for database migrations.

---

## Part 5 — Start the stack

The streaming server uses Tesla's official Docker image. Open `docker-compose.yml` and make
sure the image tag is a real one (e.g. `tesla/fleet-telemetry:latest`, or pin a specific
tag from [Docker Hub](https://hub.docker.com/r/tesla/fleet-telemetry/tags) for stability).
Then:

```bash
cd ~/tesboard/telemetry
docker compose up -d --build
docker compose ps          # all three: fleet-telemetry, mosquitto, adapter — "Up"
```

Check the streaming server is healthy (no crash loop):

```bash
docker compose logs --tail 20 fleet-telemetry   # want "starting_server" with no panic after
docker compose logs --tail 20 adapter           # want "connected to broker" + "cache warmed"
```

> The repository's Docker setup already handles the fiddly bits (build context, the right
> package manager version, the server binary path, and running the streaming container so it
> can read the certificate). If a container won't start, see
> [Troubleshooting](#troubleshooting).

---

## Part 6 — Tesla onboarding (the important part)

This tells your car to start streaming, and it's where most problems happen. Do the steps
**in order**.

### ⚠️ 6.0 — Use your EXISTING Tesla app; rotate its *secret*, not the app

If your Tesla client secret was ever exposed, **generate a new secret on the same app** in
the Tesla Developer portal. **Do NOT create a brand-new app.**

> **Why this matters (a hard-won lesson):** Tesla ties your domain registration **and** your
> car's paired key to a specific app (client ID). If you make a *new* app you'll hit
> "domain already registered / this account does not have access" and "Public key hash has
> already been taken" — because the old app still owns them, and you can't release them if
> you deleted it. Keep the same client ID; only the secret changes.

Make sure the app (in the portal) lists:
- **Allowed Origin:** `https://<app-domain>`
- **Allowed Redirect URI:** `https://<app-domain>/api/auth/tesla/callback`
- **Scopes:** vehicle information, vehicle location, vehicle commands.

Put the new secret everywhere it's used:
```bash
# In tesboard's deployment (the Cloudflare Worker secret):
wrangler secret put TESLA_CLIENT_SECRET     # paste the new secret
# And in your local .dev.vars (used by the onboarding tool).
```

### 6.1 — Make sure your public key is reachable

Tesla fetches your app's public key over HTTPS during pairing. tesboard serves it from the
app itself. Confirm it returns a key (not an HTML page):

```bash
curl -s https://<app-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
```

You should see `-----BEGIN PUBLIC KEY-----`. If you see an HTML "Not Found" page, **deploy
tesboard** (`pnpm run deploy`) so the latest version is live, then re-check.

### 6.2 — Grant the app access to your Tesla account (OAuth)

Before a key can be paired, your Tesla account must have **authorized** the app:

1. Open `https://<app-domain>`, log into your tesboard account.
2. Go to **`https://<app-domain>/api/auth/tesla/login`** in the browser. This sends you to
   Tesla to log in and **approve** access, then returns to the dashboard.

> If it bounces you to a login page, you weren't logged into tesboard — log in first, then
> retry. If you skip this step, the virtual-key pairing (next) will say *"you have not
> granted … access to your account."*

### 6.3 — Run the signing proxy

Pushing the streaming config must be **cryptographically signed** by your app's private key.
Tesla provides a small proxy that does the signing. **Run these on your laptop** (it keeps
the private key off the VM):

```bash
# Build it from source (the published module can't be `go install`ed directly):
cd ~
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command && go install ./...
export PATH="$PATH:$(go env GOPATH)/bin"

# In your tesboard checkout, make a local TLS cert for the proxy itself:
cd ~/path/to/tesboard
openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 \
  -pkeyopt ec_param_enc:named_curve -subj '/CN=localhost' \
  -keyout proxy-tls-key.pem -out proxy-tls-cert.pem -sha256 -days 3650 \
  -addext "extendedKeyUsage = serverAuth" \
  -addext "keyUsage = digitalSignature, keyCertSign, keyAgreement"

# Run it, loaded with YOUR Tesla private key (leave this terminal open):
tesla-http-proxy -tls-key proxy-tls-key.pem -cert proxy-tls-cert.pem \
  -key-file secrets/private-key.pem -port 4443
```

### 6.4 — Run the onboarding tool

In a **second terminal**, in your tesboard checkout, first copy the streaming server's
certificate chain over from the VM (it's a public certificate, safe to copy):

```bash
scp root@<vm-ip>:~/tesboard/telemetry/certs/server/tls.crt ~/telemetry-chain.pem
```

Then run a **dry run** first (no changes — it just prints what it will do):

```bash
NODE_EXTRA_CA_CERTS=proxy-tls-cert.pem pnpm telemetry:onboard \
  --vin <YOUR_VIN> \
  --hostname <telemetry-fqdn> \
  --ca-file ~/telemetry-chain.pem \
  --domain <app-domain> \
  --dry-run
```

> Two different domains, on purpose: `--hostname` is your **streaming server** (the VM);
> `--domain` is your **dashboard** (where the public key lives). `NODE_EXTRA_CA_CERTS` makes
> your computer trust the proxy's self-signed certificate for this one command.

If the dry run looks right, run it for real (drop `--dry-run`). It will:
1. Register your domain with Tesla (for your region — done automatically).
2. Print a **deep link** like `https://tesla.com/_ak/<app-domain>?vin=<YOUR_VIN>`.
   **Open it on the phone that has the Tesla app and approve "Add Virtual Key."**
3. Push the streaming config (signed) and poll until it reports
   **`synced: true, key_paired: true`** — success! 🎉

---

## Part 7 — Go live

Until now, both Polling (Cloudflare) and Telemetry (your VM) are writing — switch the app to
telemetry so the poller stands down (and you stop paying for both):

1. In your deployment config (`wrangler.jsonc`), set `"INGEST_MODE": "telemetry"`.
2. Redeploy: `pnpm run deploy`.

The poll cron now does nothing; only your VM feeds the database. Supercharger billing
reconciliation still runs as before.

---

## Part 8 — Verify it's working

The car only streams while **awake** — open the Tesla app or, best, **take a short drive**.
Then on the VM:

```bash
cd ~/tesboard/telemetry
docker compose logs -f adapter   # should show snapshots being written
```

And check the database is filling up (from your computer, or Supabase's SQL editor):

```sql
select count(*), max(recorded_at)
from vehicle_snapshot where import_source = 'telemetry';
```

A rising count with a recent timestamp = success. New drives/charges will appear in the
dashboard.

> 💡 **No logs even though the car is awake?** Messages aren't stored while the adapter is
> restarting, and a parked-but-awake car sends little. The reliable test is to **drive**.
> If the streaming server log shows the car connecting but the adapter is silent, see
> Troubleshooting.

---

## Operations

- **Cert renewal (every ~90 days):** `certbot renew`, then re-copy `fullchain.pem`/
  `privkey.pem` into `telemetry/certs/server/` and `docker compose restart fleet-telemetry`.
- **If streaming suddenly stops:** Tesla **deletes your streaming config** if you exceed
  billing limits, and does not restore it. Just re-run the onboarding tool (Part 6.4) to
  re-push it. tesboard raises a `telemetry_silent` alert when a car goes quiet, as an early
  warning.
- **Rolling back to Polling (instant):** set `"INGEST_MODE": "polling"`, `pnpm run deploy`.
  You're back on Cloudflare-only immediately; you can stop the VM. Optionally remove the
  car's config with `pnpm telemetry:onboard --vin <YOUR_VIN> --delete`.
- **Harden the VM:** SSH keys only (disable passwords), restrict port 22 to your IP, keep
  `chmod 600` on `adapter/.env` and the private key, and never open the broker's port.

---

## Troubleshooting

Every error below was hit during a real setup. Find your symptom:

| Symptom | Cause | Fix |
|---|---|---|
| `certbot: command not found` | Not preinstalled | `apt install -y certbot` |
| Cert step fails / times out | Port 80 blocked, or DNS not pointing at the VM, or the subdomain is **orange-clouded** | Open 80, confirm the A record → `<vm-ip>`, set it **DNS-only (grey)** |
| Browser shows **"This site can't be reached"** at `<telemetry-fqdn>` | This is normal — the server only accepts your *car's* certificate, not a browser. Don't test it in a browser | Judge success by container status + adapter logs, not a browser |
| `fleet-telemetry` container: `exec "-config…": no such file` | Image has no default command | Already fixed in the repo's compose (command starts with the binary). `git pull` + `docker compose up -d` |
| `fleet-telemetry`: `panic: open …/tls.crt: no such file` | Certs not in `telemetry/certs/server/` | Copy `tls.crt` + `tls.key` there (Part 3), then `docker compose up -d --force-recreate fleet-telemetry` |
| `fleet-telemetry`: `panic: open …/tls.key: permission denied` | Container can't read the key | Already fixed in the repo's compose (runs as root). `git pull` + recreate |
| Docker build fails on `pnpm install` (`MINIMUM_RELEASE_AGE`) | Newer pnpm rejects the lockfile | Already fixed (the build pins the right pnpm). `git pull` + `--build` |
| Onboarding: **412** "set a domain for your account first" | Wrong **region**, or domain not registered for this app | The tool registers automatically; ensure your account's region matches and the public key is reachable (6.1) |
| Onboarding: **422** "Public key hash has already been taken" | You're using a **new** Tesla app; the key is registered to the old one | Use the original app (rotate its secret), **or** if the app is gone, generate a fresh key pair so the new app can register it |
| Onboarding: **400** "expiration should be greater than… less than…" | Config expiry out of Tesla's allowed window | Already fixed in the repo (expiry capped under ~364 days). `git pull` |
| Onboarding: **404** "<VIN> not_found" | Using the partner token for a vehicle action | Already fixed — the tool uses your stored **user** token. Make sure you completed the OAuth grant (6.2) |
| Phone: **"you have not granted … access to your account"** | OAuth grant (6.2) not done for this app | Do 6.2: log in to the dashboard, visit `/api/auth/tesla/login`, approve |
| Public key URL returns an HTML "Not Found" page | App not deployed with the key-serving fix | `pnpm run deploy`, then re-check 6.1 |
| Adapter log: `insertSnapshot … invalid input syntax for type integer` | Telemetry sends decimals for whole-number columns | Already fixed in the repo (values are rounded). `git pull` + `docker compose up -d --build adapter` |
| Adapter has **no logs** after waking the car | Messages aren't retained over restarts; a parked-awake car is quiet | **Drive the car.** Confirm the streaming server log shows the car connecting |
| `DIRECT_URL` errors / connection churn | Using `:6543` (transaction pooler) or a wrong DB | Use the **`:5432` session pooler** URL |

Still stuck? Capture the exact error and the relevant container log
(`docker compose logs --tail 50 <service>`) before asking for help.
