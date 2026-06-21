# Choosing how tesboard collects your data

tesboard has **two ways** to get data out of your Tesla. You pick one with a single
setting (`INGEST_MODE`). This page explains the difference, what each costs, and which
one is right for you. **If you're not sure, use Polling — it's the default and needs
zero extra setup.**

---

## The two modes in one minute

| | **Polling** (default) | **Telemetry** (advanced) |
|---|---|---|
| How it works | tesboard *asks* Tesla "what's the car doing?" every couple of minutes | Your car *pushes* data to a small server you run |
| Setup effort | None — it just works after you deploy | A few hours: a $4/mo server, a domain, and Tesla key pairing |
| Who runs the data pipe | Cloudflare (already set up) | You (a tiny always-on Linux server) |
| Tesla API cost | Free for **1 car** (with idle-backoff); grows with cars | Almost free, even for several cars |
| Extra monthly cost | $0 | ~$4/mo for the server |
| Detail level | A reading every ~2 min (or ~30s while driving) | A reading every ~10s while driving |
| Read-only / no key | ✅ Yes — no virtual key on your car | ❌ Pairs a virtual key (still sends zero commands) |

**Rule of thumb:**
- **One car, you just want a nice dashboard → Polling.** Don't read the rest.
- **Multiple cars, or you drive a lot and want the cheapest long-term bill → Telemetry.**

---

## What it costs

### Tesla's side (the Fleet API bill)

Tesla charges for API use and gives every account a **$10/month free credit**. The
important facts:

- Each "what's the car doing?" check (a *vehicle data* call) costs about **$0.002**.
- A check costs money **even when the car is asleep** — so naively checking every 2
  minutes, 24/7, adds up fast.
- Telemetry streaming is billed per *signal* (~**$1 per 150,000** values) — dramatically
  cheaper per data point.

#### Polling cost (per car, per month)

tesboard's default **idle-backoff** is the key money-saver: it stops checking a parked
or sleeping car every 2 minutes and instead checks it occasionally, only ramping up when
the car is actually active. (It decides this from cheap "is the car awake?" status, never
by spending a paid check just to find out.)

| Setting | Checks/month | Tesla bill | After the $10 credit |
|---|---|---|---|
| Naive every-2-min (no backoff) | ~21,900 | ~$43.83 | **~$33.83** 😬 |
| 15-min idle-backoff | ~5,200 | ~$10.59 | ~$0.59 |
| **30-min idle-backoff (tesboard default)** | ~3,960 | ~$8.04 | **$0 — free** ✅ |

So **one car on the default settings is free.** Idle-backoff trades a little detail
(a drive that starts while the car was parked-and-awake might be noticed up to ~30 min
late) for an ~82% cost cut. You can tune `IDLE_BACKOFF_MIN` lower for more detail at more
cost.

**More cars multiply the cost.** Three cars, naive polling ≈ **$131/mo**; three cars with
30-min idle-backoff ≈ **$24/mo** after the credit. This is where Telemetry wins.

#### Telemetry cost

With a lean set of fields at ~10s (driving) / ~30s (charging), an active daily driver
generates roughly **240,000 signals/month ≈ $1.61**, comfortably under the $10 credit —
**even for several cars**. Tesla's bill is essentially free; your cost is the server.

> Supercharger billing is **not** part of either mode's data — tesboard always reconciles
> the authoritative Supercharger cost from Tesla's billing endpoint separately, in both
> modes.

### Your side (the server, telemetry only)

Telemetry needs a small **always-on Linux server** (a "VM") that your car streams to.
Requirements are tiny: 1 vCPU, ~1 GB RAM, a public IP, and port 443 open. Options:

| Provider | ~Cost/mo | Notes |
|---|---|---|
| **Oracle Cloud "Always Free"** | **$0** | Genuinely free ARM VM, but availability is a lottery and idle free instances can be reclaimed — upgrade to Pay-As-You-Go (still $0 within free limits) to keep it. US/EU regions. |
| **Aliyun Simple App Server (Intl.)** | **~$4** | Singapore/APAC region (low latency if you're in Asia); no China ICP filing needed on the international site. Simple, predictable. |
| **Hetzner CX22** | **~€4** | Excellent value, EU data centers. |
| **Google Cloud e2-micro** | **~$3–4** | "Free tier" is US-only **and** no longer truly free — Google now charges ~$3–4/mo for the public IPv4 address. |
| **DigitalOcean / Vultr / Linode** | **~$4–6** | Easiest dashboards; fine anywhere. |

Pick the region **closest to you and your Supabase database** for low latency. Any of
these works; the guide uses general steps that apply to all.

> ⚠️ A managed "someone else hosts the telemetry server" service exists but costs ~**$32/mo
> per car** and ties you to their service — not recommended for a self-hosted tool.

---

## Effort, honestly

- **Polling:** deploy tesboard, link your Tesla in the dashboard, set your electricity
  rate. Done. ~15 minutes, no command line beyond the initial deploy.
- **Telemetry:** rent a VM, point a subdomain at it, get a TLS certificate, run three
  Docker containers, pair a Tesla "virtual key", and push a streaming config. ~2–4 hours
  the first time, and it involves the terminal. The
  **[telemetry setup guide](./telemetry-setup.md)** walks every step and has a
  troubleshooting section for the things that commonly go wrong.

---

## Which should I choose?

- **"I have one Tesla and want a dashboard."** → **Polling.** It's free under the $10
  credit and needs no server. Stop here.
- **"I have 2+ Teslas," or "I drive a lot and want the lowest possible long-term bill,"
  or "I want ~10-second driving detail."** → **Telemetry**, if you're comfortable
  following a technical guide (or have someone who is).
- **"I'm not technical and just want it to work."** → **Polling.**

**You're not locked in.** You can start on Polling and switch to Telemetry later (or roll
back instantly) by changing one setting and redeploying — your existing data stays put.

➡️ Ready for Telemetry? **[Telemetry setup guide →](./telemetry-setup.md)**
