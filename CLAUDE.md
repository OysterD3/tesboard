<!-- intent-skills:start -->
## Skill Loading

Before substantial work:
- Skill check: run `pnpm dlx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->

## Project Context

Durable context for this project. Read this before making architectural or library changes, and keep it current.

### What this is
A **blank TanStack Start** application (React, file-based router, SSR-capable). No extra partner integrations or feature scaffolding beyond the default blank starter.

### How it was scaffolded
- TanStack CLI command (run exactly as given, in agent mode):
  ```
  npx @tanstack/cli@latest create my-tanstack-app --agent
  ```
  In this environment `npx` is blocked by a hook in favor of pnpm, so it was executed as `pnpm dlx @tanstack/cli@latest create my-tanstack-app --agent`. Same package, same result.
- Follow-up TanStack Intent commands:
  ```
  npx @tanstack/intent@latest install   # wired skill-loading guidance into AGENTS.md (the intent-skills block above)
  npx @tanstack/intent@latest list      # lists the available shipped skills for Router/Start/Devtools
  ```
  (Also run via `pnpm dlx` here for the same reason.)
- The CLI generated the app into `my-tanstack-app/`. Because the project root (`tesboard/`) was empty — no host platform template to merge into — the generated files (including `.git`) were moved up to the project root so this directory *is* the app. `package.json` `name` was changed from `my-tanstack-app` to `tesboard`; nothing else in the generated structure was altered.

### Chosen stack & integrations
- **Framework:** React 19 (`react`, `react-dom`)
- **Routing/SSR:** TanStack Start (`@tanstack/react-start`) + TanStack Router (`@tanstack/react-router`) with file-based routing
- **Router mode:** file-router (`.cta.json` → `mode: "file-router"`), routes in `src/routes/`, generated `src/routeTree.gen.ts`
- **Build/toolchain (default CLI toolchain):** Vite 8 + `@tanstack/react-start/plugin/vite`, `@vitejs/plugin-react`, `@tanstack/router-plugin`
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite` (+ `@tailwindcss/typography`). Included by the blank starter; not an opt-in partner add-on.
- **Devtools:** `@tanstack/react-devtools` + router devtools, stripped from production via `@tanstack/devtools-vite`
- **Icons:** `lucide-react`
- **Testing:** Vitest 4 + Testing Library + jsdom
- **Language:** TypeScript 6, package manager **pnpm**
- **Partner integrations:** none selected (`.cta.json` → `chosenAddOns: []`). This is intentional — the request was the blank starter with no extra integrations. Nothing requested was dropped.

### Scripts
- `pnpm dev` — Vite dev server on port 3001
- `pnpm build` — production build (client + SSR; verified passing)
- `pnpm preview` — preview the production build
- `pnpm generate-routes` — regenerate the route tree (`tsr generate`)
- `pnpm test` — run Vitest

### Environment variables
- **None required** to run the blank starter; there is no `.env` / `.env.example`, and no `process.env` / `import.meta.env` usage in `src/`.
- When you add env vars: client-exposed values **must** be prefixed `VITE_` (anything without it stays server-only). `.env` is gitignored — commit a `.env.example` documenting required keys, never the real `.env`.

### Deployment notes
- TanStack Start runs on a Nitro-style server build; `pnpm build` emits `dist/client` and `dist/server` (`dist/server/server.js`).
- No deployment target is configured yet. For Cloudflare Workers / Netlify / Vercel / Node / Bun specifics, load the shipped skill before configuring:
  `pnpm dlx @tanstack/intent@latest load @tanstack/start-client-core#start-core/deployment`

### Key architectural decisions
- Project lives at the repo root (not a subfolder) — see "How it was scaffolded".
- Path alias `#/*` → `./src/*` (defined in `package.json` `imports`); `vite.config.ts` uses `resolve.tsconfigPaths: true`.
- Keep the default CLI toolchain and the generated project structure unless there's a clear reason to change.

### Known gotchas
- This environment blocks `npm`/`npx` and `grep` via hooks — use `pnpm` / `pnpm dlx` and `rg`.
- `src/routeTree.gen.ts` is generated — don't hand-edit it; run `pnpm generate-routes` (the dev server and build also regenerate it).
- Devtools are dev-only and removed from production builds by `@tanstack/devtools-vite`.

### Next steps
- `pnpm dev` to start developing; add routes under `src/routes/` (see `README.md` → Routing).
- Before any substantial/library-specific change, follow the Skill Loading section above (`intent list` → `intent load`).

---

## Tesla Dashboard (the actual product)

This section is the quick durable map.

### What it is
A **read-only** personal dashboard for a Tesla on the official **Fleet API**. MVP: charging history, per-charge stats (cost + drivable range), drive records. **No vehicle commands** (read-only avoids the signed-command protocol + virtual-key pairing).

### The one architectural truth
The Fleet API has **no trip-history endpoint** and **only bills Supercharger sessions**. So the app is a **sleep-aware poller → Postgres** + a **sessionization engine**, not an API proxy. The UI reads only from Postgres and **never wakes the car** (a `vehicle_data` read on a sleeping car returns 408 and does not wake it; we never call `wake_up`). Home-charge cost is **computed** = `energy_added × rate × loss_factor`; Supercharger cost is **authoritative** from `/dx/charging/history` (reconciliation fills it, `cost_source` distinguishes `tesla_billed` vs `computed`).

### Chosen stack & decisions (user-approved 2026-06-14)
- **Datastore:** Supabase Postgres (`tesboard`, ref `YOUR_SUPABASE_REF`, **your region**). **Data access = Drizzle ORM** (`drizzle-orm` + `postgres-js`), reached at runtime through **Cloudflare Hyperdrive** — raw postgres-js TCP to Supabase **hangs inside workerd** (dev + prod), so `src/worker.ts` bridges `env.HYPERDRIVE.connectionString` → `process.env.DATABASE_URL` and `db.ts` connects to that (`prepare:false, fetch_types:false, max:5`). Hyperdrive's origin = the Supabase **session** pooler (5432); it does its own pooling. **Auth = Supabase Auth** (email+password) only — login + JWT/cookie validation; Drizzle does the rest. **Security = app-enforced `user_id`:** Drizzle connects as the DB owner (RLS bypassed) and every query filters by `user_id` (from `getSessionUser()` for UI fns, or the job's user for background jobs). RLS is still **enabled (lockdown, no policies)** on every table so the public anon key can't read them via Supabase's auto PostgREST API. **drizzle-kit owns the schema** (`src/server/schema.ts` → `pnpm db:generate` → `drizzle/` → `pnpm db:migrate` via `DIRECT_URL`, bypassing Hyperdrive). Migration `0000` is **applied**; the 8 tables exist (all RLS-enabled), older orphan tables dropped. *(Prior design used the Supabase JS client + RLS via `auth.uid()` + a service-role client for jobs — replaced 2026-06-14.)*
- **Single-user:** there is **no public sign-up** — the login page only signs in. The one account is provisioned out of band via `pnpm user:create <email> <password>` (`scripts/create-user.mjs`, admin API, auto-confirmed). Harden further by disabling "Allow new users to sign up" in Supabase Auth settings, since the anon key could otherwise hit the signUp endpoint directly.
- **OAuth scope:** `openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds`. `vehicle_charging_cmds` is needed to *read* `/dx/charging/history`; we send **zero commands**, so it stays read-only with no virtual key.
- **Rate model:** flat `$/kWh` + loss factor (~1.1); TOU schema stubbed (`electricity_rate.tou_schedule`).
- **Tesla region:** do NOT assume NA. Resolved at link time via `GET /api/1/users/region` and stored in `tesla_account.fleet_api_base_url`.

### Layout
- DB schema (drizzle-kit owns it): `src/server/schema.ts` → generated SQL in `drizzle/` (config `drizzle.config.ts`). Drizzle client: `src/server/db.ts` (`getDb()`, postgres-js over the pooler).
- Server (server-only): `src/server/env.ts`, `db.ts` (Drizzle client), `db.server.ts` (Supabase **Auth only** — `getAuthClient()`/`getSessionUser()`), `auth-middleware.ts`, `oauth-cookie.ts`, `poller.ts`, `reconcile.ts`, `tesla/` (`oauth.ts`, `client.server.ts`, `token-store.ts`, `crypto.ts`, `types.ts`)
- Routes (server): `src/routes/api/auth/tesla/{login,callback}.ts`, `src/routes/api/cron/poll.ts`
- Server fns (RLS reads): `src/functions/{overview,charging,drives,rate,account}.functions.ts`
- UI: `src/routes/login.tsx`, `src/routes/dashboard.tsx` (+ `dashboard/{index,charging,drives,settings}.tsx`), `src/components/Stat.tsx`, browser auth client `src/lib/supabase-browser.ts`

### Deployment: Cloudflare Workers
- **Config:** `vite.config.ts` adds `cloudflare({ viteEnvironment: { name: 'ssr' } })`; `wrangler.jsonc` has `compatibility_flags: ["nodejs_compat"]` (gives `node:crypto` + per-request `process.env`), `main: src/worker.ts`, and `triggers.crons`. `pnpm build` emits `dist/` + `dist/server/wrangler.json`; `pnpm deploy` = `vite build && wrangler deploy`. Validated via `wrangler deploy --dry-run`.
- **Custom worker entry** `src/worker.ts`: re-exports the TanStack Start `fetch` handler **and** adds a `scheduled()` handler so the **poller runs on native Cloudflare Cron Triggers** — no external scheduler. Schedules: `*/2 * * * *` → poll, `0 * * * *` → reconcile (distinguished by `event.cron`). `scheduled()` bridges Worker bindings into `process.env` (the non-request context doesn't auto-populate it).
- **Static `.well-known` key:** `public/.well-known/appspecific/com.tesla.3p.public-key.pem` ships in `dist/client` and is served by Workers Assets at `https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`. (Generated key pair lives in gitignored `secrets/`; private key NOT needed at runtime for read-only.)
- **Env model (Cloudflare):** server runtime vars/secrets come from `process.env` in the Worker — local dev via `.dev.vars` (see `.dev.vars.example`), prod via wrangler.jsonc `vars` (non-secret) + `wrangler secret put` (secret). The `VITE_*` pair is build-time (Vite reads `.env`, bakes into the client bundle). Cadence/cost knob: Cloudflare cron min is 1 min; `*/2` balances drive granularity vs the ~$10/mo Fleet API credit.
- **Database connection = the `HYPERDRIVE` binding** in wrangler.jsonc (`id` from `wrangler hyperdrive create`, origin = Supabase session pooler 5432). Local dev: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` must be in the **process env** (the vite plugin reads it there, not from `.dev.vars`) — the `pnpm dev` script loads `.dev.vars` into the process env via `dotenv-cli` to make this work. So `DATABASE_URL` is **not** a Worker secret — it's bridged from the binding at runtime; `DATABASE_URL`/`DIRECT_URL` only matter for `pnpm db:migrate`.
- **Set as secrets** (`wrangler secret put <NAME>`): `TESLA_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_TRIGGER_SECRET`, `SESSION_SECRET`, (optional) `TESLA_PRIVATE_KEY_PEM`. **NOT a Worker secret:** `SUPABASE_SERVICE_ROLE_KEY` is only used by `pnpm user:create`. **Set as `vars`** in wrangler.jsonc: `APP_ORIGIN`, `TESLA_CLIENT_ID`, `TESLA_REDIRECT_URI`, `TESLA_APP_DOMAIN`, `TESLA_FLEET_BASE_URL`, `TESLA_OAUTH_AUDIENCE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

### Environment variables
All documented in `.env.example` + `.dev.vars.example`. **All server-only except** the public `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (browser auth; anon key is RLS-gated, lives in `.env`). Tesla tokens are AES-256-GCM encrypted at rest via `TOKEN_ENCRYPTION_KEY`. The `/api/cron/poll` HTTP route is still guarded by `CRON_TRIGGER_SECRET` (Bearer) for manual/external triggering, but on Cloudflare the cron uses the in-worker `scheduled()` path directly.
- ⚠️ **The Tesla `TESLA_CLIENT_SECRET` was pasted in chat — ROTATE it** in the Tesla Developer portal.

### Manual setup the user must do (app can't)
Deploy to **Cloudflare** (`wrangler login`; set worker name + **custom domain** so the OAuth redirect + `.well-known` URL resolve over HTTPS) → set `vars` in wrangler.jsonc + `wrangler secret put` the secrets → the EC public key is already served by the app at `/.well-known/appspecific/com.tesla.3p.public-key.pem` once the domain is live → register Tesla app scopes + redirect `https://<domain>/api/auth/tesla/callback` → partner registration (`POST /api/1/partner_accounts`) → resume Supabase + apply schema with `pnpm db:migrate` (set `DATABASE_URL` first; uses the **direct** 5432 connection for DDL) → `pnpm user:create` → sign in + Link Tesla → set electricity rate. The poller then runs automatically on **Cloudflare Cron Triggers** (no manual scheduler). Steps in the design doc §9 (deployment-target details under §Deployment).

### Known gotchas (Tesla-specific)
- **Refresh-token rotation is atomic** — Tesla rotates the refresh token every refresh; `token-store.ts` overwrites the row on refresh. Stale reuse breaks the chain → re-link.
- Partner registration + hosted public key are **required even read-only** (skip → 412). 412 can also mean wrong region.
- Use `charge_energy_added` (battery side), not billed `usageBase`, for range/efficiency math.
- Drive records only accrue while the poller runs (no backfill); scheduler gaps = history gaps.
- TanStack: server fns are independently-reachable RPCs → `authMiddleware` on every data fn (route `beforeLoad` guards are UX-only); never `Cache-Control: public` on identity responses; read env only inside `.server()` handlers.
- **Drizzle/DB:** raw postgres-js TCP to Supabase **HANGS in workerd** (you'll see "Worker's code had hung" / a request timeout, not a clean error) — runtime DB MUST go through **Hyperdrive** (`HYPERDRIVE` binding → bridged to `DATABASE_URL` in `src/worker.ts`). **Never cache the DB client across requests** — a Worker I/O object (the socket) is bound to its creating request; reusing a module-level singleton on a later request throws *"Cannot perform I/O on behalf of a different request"*. `getDb()` builds a fresh client per call; call it ONCE per request/cycle and pass `db` down. **Hyperdrive origin MUST be the Supabase SESSION pooler (`:5432`) or direct — NEVER the `:6543` transaction pooler.** Pointing it at 6543 causes a connection storm (dozens of conns/sec in Supabase logs) and the dashboard hangs/spins, because Hyperdrive holds long-lived conns that the transaction pooler tears down per-txn. Fix in place with `wrangler hyperdrive update <id> --connection-string=…:5432…` (no redeploy; same binding id). Current config id `YOUR_HYPERDRIVE_ID` → session pooler. Migrations bypass Hyperdrive and connect directly via `DIRECT_URL` (session/direct 5432; DDL can't run over the 6543 transaction pooler). Schema is **snake_case TS keys** + `timestamp({mode:'string'})` (ISO strings) + `numeric({mode:'number'})` (real numbers, else postgres-js returns strings and the cost math breaks). RLS is **enabled with no policies** (anon-via-PostgREST lockdown); the app relies on `user_id` filters, so a query that forgets `eq(table.user_id, …)` leaks across users — always include it. h3 hides unhandled errors as `{"message":"HTTPError"}`; the OAuth callback now catches + redirects with the real reason.

### Status
MVP code complete and **typechecks + builds clean + `wrangler deploy --dry-run` clean** against `.env` placeholders (DB layer = Drizzle/postgres-js, validated to bundle for workerd). Not yet run end-to-end (blocked on the manual Tesla onboarding above). Phase-2 features (cost analytics, efficiency, maps, degradation, exports) are scoped in the design doc §10.

A multi-agent adversarial review (`tesla-dashboard-review` workflow) confirmed 15 issues; **all addressed** — notably: atomic refresh-token rotation (single-flight + compare-and-swap, guard against Tesla omitting `refresh_token`), partial unique indexes + a stale-session reaper so a vehicle can't hold two open sessions or leave one open forever, reset-aware `charge_energy_added` summation, sustained-power Supercharger classification, drive-energy clamping (no negative/quantized Wh/mi), DB-error capture in the poller, OAuth `state` constant-time compare + binding the flow to the initiating Supabase user, a browser/server Supabase project-ref mismatch guard, and forced token refresh on 401.

---

## TeslaMate parity & migration (added 2026-06-15)

Brought tesboard toward TeslaMate feature parity AND added a one-way TeslaMate→tesboard importer. The `PACK_KWH = 75` deferral is **resolved** — pack size + a derived efficiency factor are now per-`vehicle` columns.

### What was built (all typechecks + builds + `wrangler deploy --dry-run` clean; 42 unit tests pass via `pnpm test`)
- **Schema (`drizzle/0003_*`, additive, RLS-on):** `vehicle` gained `model/trim_badging/marketing_name/exterior_color/wheel_type/spoiler_type/pack_kwh/efficiency_wh_per_mi/is_lfp/free_supercharging/display_priority`; `drive_session` + `charge_session` gained range/temp/power aggregates + `import_source`/`source_pk` + partial-unique import keys; `vehicle_snapshot` gained `charger_voltage/charger_actual_current/charger_phases/power_kw/elevation_m/source_drive_id/source_charge_id/import_source/source_pk`; **new tables** `geofence`, `address`, `vehicle_state`, `software_update`, `import_batch`, `import_pk_map`. **Run `pnpm db:migrate` (DIRECT_URL) to apply — not yet applied to the live DB.**
- **Migration importer (CLI, reads both DBs):** `pnpm import:teslamate <email> [--no-samples] [--positions-interval=60] [--charges-interval=30] [--dry-run]`. Needs `TESLAMATE_DATABASE_URL` (self-hosted TeslaMate PG) + `DIRECT_URL` (tesboard session 5432). `scripts/import-teslamate.mjs` orchestrates a DAG ingest (cars→geofences→addresses→charging_processes→drives→positions/charges→states→updates) with in-memory PK remap + idempotent `ON CONFLICT` upserts; pure km→mi/kWh/cost mapping in `scripts/teslamate/convert.mjs` (unit-tested). Imports full history; downsamples the huge `positions`/`charges` streams by time interval; tags imported rows so the live poller/reconcile never overwrite them.
- **Geofences + billing (`src/server/cost.ts`, `geo.findGeofence`, `geofences.functions.ts`, `/dashboard/geofences` editor):** named zones with per-kWh/per-minute/per-session billing + session fee + free-supercharging; nearest-wins matching wired into the poller charge-close and the geofence-aware `reclassifyCharges`. The Home zone syncs `electricity_rate.home_*`.
- **Per-vehicle efficiency (`src/server/efficiency.ts`):** modal-bucket Wh/mi factor recomputed after each charge; poller drive energy now = rated-range-drop × efficiency (fallback pack×SOC).
- **States + firmware tracking:** poller writes `vehicle_state` intervals (online/asleep/offline) on transition + `software_update` rows on `car_version` change.
- **Analytics (`/dashboard/analytics` tab):** battery health/degradation/projected range (`battery.functions.ts`), efficiency-vs-outside-temp bins (`efficiency-analysis.functions.ts`), mileage-by-period (`mileage.functions.ts`), time-in-state + unified timeline (`states`/`timeline.functions.ts`). Pure builders in `src/lib/analytics-vm.ts` (tested).
- **Battery-health drill-in (`/dashboard/battery`, Tessie-style):** tapped from the Analytics battery tile. Two scatter charts — **Capacity (kWh)** and **Max range** — plotted vs **odometer** with an OLS trend line (`src/components/dashboard/BatteryScatter.tsx`, hand-rolled SVG). `getBatteryHealthCore` now filters charges to `energy_added_kwh > 5` (Tessie's ">5 kWh charge" denoise), derives per-charge odometer from the nearest preceding `drive_session.end_odometer` (charge_session has no odometer column) on the **shared** aggregate `db` handle (no extra connection), and returns `readings[] {date, odometerMi, capacityKwh, maxRangeMi}` + `currentMaxRangeMi`/`maxRangeBestMi`. Max range is **efficiency-free** (`rangeMi×100/soc` via `maxRangeMiAtFull`) so it works before the Wh/mi factor is derived; capacity still needs `efficiency_wh_per_mi`. Trend line is labeled "Trend" (no fleet data → no fake "fleet average"). New VM helpers `linearRegression`/`odometerForTime`/`buildBatteryReadings`/`recentMean` are unit-tested.
- **Reverse geocoding (`src/server/geocode.ts`):** Nominatim → `address` cache (deduped on osm_id). Deliberately OFF the cron path (rate limits); intended to be driven by an on-demand backfill.

### Deliberately de-scoped (architectural — 2-min cloud Fleet poll vs TeslaMate's ~2.5s local stream)
MQTT/realtime; dense road-shaped GPS paths + per-sample power/elevation traces; precise update-install durations. See doc §1.

### Remaining (not yet built — UI/polish)
Reverse-geocode **backfill** server fn + address display in UI; lifetime heat/track map (`visited`); dedicated charge-curve V/A detail; a `pack_kwh` setter + multi-vehicle switcher wired to `getVehicles` (the switcher already exists via `overview`); CSV/JSON export. Cutover/overlap policy for import-vs-live seam is "import everything, dedupe via partial-unique `(vin, started_at)`" — see doc §7 open questions.

### Status
MVP + TeslaMate-parity code complete and **typechecks + builds clean + `wrangler deploy --dry-run` clean**. `pnpm test` (Vitest via a dedicated `vitest.config.ts` that omits the Cloudflare plugin, which is incompatible with Vitest) = 42 passing. Not yet run end-to-end (blocked on the manual Tesla onboarding above + applying migration `0003`).
