/**
 * Provision the single dashboard user (this app has no public sign-up).
 *
 * Usage:
 *   node scripts/create-user.mjs <email> <password>
 *   pnpm user:create <email> <password>
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment, falling
 * back to .dev.vars then .env. The created user is auto-confirmed so you can sign
 * in immediately. Run this in YOUR terminal — the password never goes in chat.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadFromFile(path, key) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (m && m[1] === key) {
        return m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    /* file may not exist */
  }
  return undefined
}

function resolve(key) {
  return (
    process.env[key] ||
    loadFromFile('.dev.vars', key) ||
    loadFromFile('.env', key) ||
    ''
  )
}

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('Usage: node scripts/create-user.mjs <email> <password>')
  process.exit(1)
}

const url = resolve('SUPABASE_URL')
const serviceRoleKey = resolve('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (checked env, .dev.vars, .env).',
  )
  process.exit(1)
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
})

if (error) {
  console.error(`Failed to create user: ${error.message}`)
  process.exit(1)
}

console.log(`✓ Created (auto-confirmed) user: ${data.user.email} [${data.user.id}]`)
console.log('You can now sign in at /login.')
