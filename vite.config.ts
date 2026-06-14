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
    tanstackStart(),
    viteReact(),
  ],
})

export default config
