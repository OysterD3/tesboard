import { readFileSync } from 'node:fs'
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit owns the schema. Generate migrations with `pnpm db:generate`,
 * apply them with `pnpm db:migrate`.
 *
 * `schemaFilter: ['public']` keeps drizzle-kit scoped to our tables — it won't
 * try to manage Supabase's `auth` schema (which we only reference via FK).
 *
 * Connection: migrations run DDL, which can't go over the Supabase TRANSACTION
 * pooler (6543) the app runtime uses. Use a SESSION/DIRECT connection (port
 * 5432) here. We read it from the environment, then `.dev.vars`, then `.env`,
 * preferring DIRECT_URL (session/direct) and falling back to DATABASE_URL.
 *   Supabase → Project Settings → Database → Connection string → "Session"
 */
function fromFile(path: string, key: string): string | undefined {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch {
    /* file may not exist */
  }
  return undefined
}

function resolve(key: string): string | undefined {
  return process.env[key] || fromFile('.dev.vars', key) || fromFile('.env', key) || undefined
}

const url = resolve('DIRECT_URL') ?? resolve('DATABASE_URL') ?? ''

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/schema.ts',
  out: './drizzle',
  schemaFilter: ['public'],
  dbCredentials: { url },
})
