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
# Pin pnpm to the version that generated the lockfile. corepack would otherwise pull the
# LATEST pnpm, which enforces a `minimumReleaseAge` supply-chain gate (NOT overridable via
# project .npmrc) that rejects the committed lockfile's newest entries and fails the frozen
# install. Matching the local pnpm sidesteps the gate entirely.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install the adapter's deps at the BUILD ROOT so one node_modules serves both the adapter
# sources AND the shared src/server/* they import.
COPY telemetry/adapter/package.json telemetry/adapter/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

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
