/**
 * WS-1: AES-256-GCM encrypt/decrypt for workspace_project_settings.credentials.
 *
 * GCM is an authenticated mode: the 16-byte auth tag is stored alongside the
 * ciphertext, and decryption fails (throws) if the ciphertext or IV has been
 * tampered with. We use a fresh 12-byte IV on every encrypt — never reuse.
 *
 * Key sourcing:
 *   - Production: HEALIX_WORKSPACE_SECRET_KEY is REQUIRED. Must be a base64
 *     string that decodes to exactly 32 bytes. Throw at module load if absent
 *     or malformed so a forgotten env var fails the deploy, not a request.
 *   - Non-production (NODE_ENV !== 'production'): if the env var is missing,
 *     auto-generate an in-memory 32-byte key on first use and warn loudly.
 *     The key is held in module scope and lost on process restart — fine for
 *     dev/test, fatal for prod (which is why the gate above is hard).
 *
 * Why not file-encrypt + KMS: out of scope for v1 (see plan). We accept
 * encrypt-at-rest with a single shared secret managed via env.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // GCM IV
const TAG_BYTES = 16 // GCM auth tag

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
  if (cachedKey) return cachedKey

  const raw = process.env.HEALIX_WORKSPACE_SECRET_KEY
  if (!raw || raw.trim().length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'HEALIX_WORKSPACE_SECRET_KEY is required in production (32-byte base64). ' +
          'Generate with `openssl rand -base64 32`.'
      )
    }
    // Dev/test fallback — random per-process key. Decryption of previously
    // written rows will fail across process restarts; that's fine for tests.
    const dev = randomBytes(KEY_BYTES)
    console.warn(
      '[crypto-aes] WARNING: HEALIX_WORKSPACE_SECRET_KEY not set — generated an ephemeral dev key. ' +
        'Workspace settings written with this key will be unreadable after process restart. ' +
        'Set HEALIX_WORKSPACE_SECRET_KEY in webapp/.env.local before any real use.'
    )
    cachedKey = dev
    return cachedKey
  }

  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    throw new Error(
      'HEALIX_WORKSPACE_SECRET_KEY must be base64-encoded. Generate with `openssl rand -base64 32`.'
    )
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `HEALIX_WORKSPACE_SECRET_KEY must decode to exactly ${KEY_BYTES} bytes; got ${buf.length}. ` +
        'Generate with `openssl rand -base64 32`.'
    )
  }
  cachedKey = buf
  return cachedKey
}

export type EncryptedEnvelope = {
  ciphertext: string // base64
  iv: string // base64 (12 bytes)
  authTag: string // base64 (16 bytes)
}

/**
 * Encrypt an arbitrary JSON-serialisable value. Throws on serialisation
 * failure (circular refs etc.) or key misconfiguration.
 */
export function encryptJson(value: unknown): EncryptedEnvelope {
  const key = loadKey()
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct1 = cipher.update(plaintext)
  const ct2 = cipher.final()
  const ciphertext = Buffer.concat([ct1, ct2])
  const authTag = cipher.getAuthTag()
  if (authTag.length !== TAG_BYTES) {
    // Defensive — Node always returns 16 bytes for GCM but guard anyway.
    throw new Error(`unexpected GCM tag length: ${authTag.length}`)
  }
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  }
}

/**
 * Decrypt an EncryptedEnvelope and JSON.parse the plaintext. Throws on
 * tampered/corrupt ciphertext (GCM auth tag check) or invalid JSON.
 */
export function decryptJson<T = unknown>(env: EncryptedEnvelope): T {
  if (!env || typeof env !== 'object') {
    throw new Error('decryptJson: envelope is required')
  }
  if (
    typeof env.ciphertext !== 'string' ||
    typeof env.iv !== 'string' ||
    typeof env.authTag !== 'string'
  ) {
    throw new Error('decryptJson: envelope must have ciphertext/iv/authTag (base64 strings)')
  }
  const key = loadKey()
  const iv = Buffer.from(env.iv, 'base64')
  const tag = Buffer.from(env.authTag, 'base64')
  const ct = Buffer.from(env.ciphertext, 'base64')
  if (iv.length !== IV_BYTES) throw new Error(`decryptJson: IV must decode to ${IV_BYTES} bytes`)
  if (tag.length !== TAG_BYTES) throw new Error(`decryptJson: authTag must decode to ${TAG_BYTES} bytes`)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt1 = decipher.update(ct)
  const pt2 = decipher.final() // throws on tampered ciphertext (GCM verification fail)
  const plaintext = Buffer.concat([pt1, pt2]).toString('utf8')
  return JSON.parse(plaintext) as T
}

/**
 * Test-only — reset the cached key so unit tests can swap env vars between
 * cases. Never call this from runtime code.
 */
export function _resetKeyForTests(): void {
  cachedKey = null
}
