# Multi-stage build for the tesboard telemetry adapter.
#
# IMPORTANT: the build CONTEXT is the REPO ROOT (see docker-compose.yml:
# build.context = .. , dockerfile = telemetry/adapter/Dockerfile), NOT telemetry/adapter.
# The adapter bundles shared code from ../../src/server/* (sessionize, schema, liveness),
# so those files must be inside the build context.
#
# The shared src/server graph needs only ONE external package at bundle time:
# drizzle-orm (./db is a TYPE-only import, so the workerd DB client is never pulled in).
# That dep — plus the adapter's own mqtt/postgres/dotenv/esbuild — all come from a SINGLE
# node_modules installed at the build root from telemetry/adapter/package.json. esbuild then
# resolves both trees from it (walking up from each file), exactly like local dev.

# --- build: install adapter deps at the root, copy both trees, bundle ---
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable

# Install the adapter's deps at the BUILD ROOT so one node_modules serves both the adapter
# sources AND the shared src/server/* they import.
COPY telemetry/adapter/package.json telemetry/adapter/pnpm-lock.yaml ./
# corepack pulls the latest pnpm, which enforces a `minimum-release-age` supply-chain gate
# that rejects lockfile entries newer than its cutoff. That gate is for ADOPTING new
# packages; we install the committed lockfile FROZEN (reproduce, don't adopt), so disable
# it for this build only. Does not affect your local/host pnpm policy.
RUN printf 'minimum-release-age=0\n' > .npmrc && pnpm install --frozen-lockfile

# Sources: the shared app code + the adapter (node_modules/dist/.env excluded via .dockerignore).
COPY src ./src
COPY telemetry/adapter ./telemetry/adapter

# esbuild bundles all deps into a single dist/index.js (ESM, node target).
RUN cd telemetry/adapter && pnpm run build

# --- runtime: only the self-contained bundle is needed ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/telemetry/adapter/dist ./dist
USER node
CMD ["node", "dist/index.js"]
