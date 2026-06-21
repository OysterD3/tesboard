import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Adapter unit tests run in plain node (no infra). Only the PURE modules
 * (coalesce.ts, map-fields.ts) are tested here — they have no mqtt/postgres
 * imports, so the suite needs no broker or DB. The `@core/*` alias mirrors
 * tsconfig + the esbuild build so shared-code imports resolve in tests too.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../../src/server', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
