import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Dedicated Vitest config. The app's vite.config.ts loads the Cloudflare Workers
 * plugin (workerd runtime), which is incompatible with Vitest's environment, so
 * we DON'T extend it here. Unit tests are pure logic (conversions, view-model
 * builders, reducers) and run in a plain node environment. Keep the `#/*` path
 * alias so tests can import app modules the same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
