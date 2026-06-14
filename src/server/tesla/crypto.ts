/**
 * App-layer encryption for Tesla tokens at rest (AES-256-GCM).
 * Tokens expose vehicle location history, so they are never stored in plaintext.
 * Key: TOKEN_ENCRYPTION_KEY = base64-encoded 32 bytes.
 * Format: base64( iv(12) || authTag(16) || ciphertext ).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { serverEnv } from '../env'

function key(): Buffer {
  const raw = Buffer.from(serverEnv.app().tokenEncryptionKey, 'base64')
  if (raw.length !== 32) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 bytes base64-encoded. ' +
        'Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }
  return raw
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptToken(payload: string): string {
  const buf = Buffer.from(payload, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  )
}
