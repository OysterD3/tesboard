import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // Runs the SSR/server code in the Cloudflare Workers (workerd) runtime for
    // both `vite dev` and the production build, so local dev matches prod.
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    devtools(),
    tailwindcss(),
    // SPA mode: pages render on the CLIENT (no SSR), while the server still hosts
    // server functions + the /api/* OAuth/cron routes + the cron `scheduled()`
    // handler in worker.ts. The build prerenders the root shell to /_shell.html
    // and rewrites 404s to it. This removes the SSR hydration-mismatch class of
    // bugs and offloads render CPU from the Worker.
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
})

export default config
