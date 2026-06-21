# tesboard — User Guide

tesboard is a personal, read-only dashboard for your Tesla. It collects your driving and
charging data into your own database and shows it as charts, maps, and stats.

There are **two ways** it can collect data. Start here:

### 📖 [Choosing a mode →](./choosing-a-mode.md)
Polling vs. Telemetry, **what each costs**, and **VM options**. Read this first.

| If you… | Use | Setup |
|---|---|---|
| Have **one car**, want a dashboard | **Polling** | None — it's the default |
| Have **multiple cars**, drive a lot, or want the cheapest long-term bill | **Telemetry** | [Step-by-step guide →](./telemetry-setup.md) |

---

## Quick start — Polling (the default, free for one car)

Polling needs **no extra server**. Once tesboard is deployed:

1. **Open your dashboard** and create your account (a one-time admin step provisions the
   single login).
2. **Link your Tesla:** log in, go to Settings → **Connect / Link Tesla**, and approve
   access in the Tesla sign-in screen.
3. **Set your electricity rate** (Settings) so home-charging cost is calculated correctly.

That's it. tesboard checks your car periodically and builds your drive/charge history. With
the default **idle-backoff**, one car stays within Tesla's **$10/month free credit** — so
it's effectively **free**. (Cost details: [Choosing a mode](./choosing-a-mode.md#tesla-s-side-the-fleet-api-bill).)

> Your data only accrues while tesboard is running — there's no historical backfill from
> Tesla. (You *can* import past data from TeslaMate/Tessie separately.)

---

## Telemetry (advanced, cheapest at scale)

Telemetry has your car **stream** data to a small server you run (~$4/month), giving
near-zero Tesla API cost and ~10-second driving detail. It takes a few hours to set up and
involves the terminal.

➡️ **[Telemetry setup guide →](./telemetry-setup.md)** — every step, plus a troubleshooting
section for the common errors.

---

## Switching modes

You can move between modes any time by changing one setting (`INGEST_MODE`) and redeploying.
Your existing data is untouched, and rolling back to Polling is instant.
