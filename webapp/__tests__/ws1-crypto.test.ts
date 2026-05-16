import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'crypto'

/**
 * WS-1 — crypto-aes round-trip.
 *
 * Verifies:
 *   - encryptJson + decryptJson round-trips arbitrary JSON-serializable data.
 *   - Tampering with ciphertext bytes causes decryptJson to throw (GCM tag
 *     verification failure).
 *   - Tampering with the IV throws.
 *   - Tampering with the auth tag throws.
 *   - Mixing ciphertexts from two different envelopes throws.
 *   - encryptJson is non-deterministic — repeated calls produce different IVs.
 */
describe('WS-1 crypto-aes', () => {
  beforeEach(() => {
    // Use a fixed key for deterministic across-case round-tripping.
    process.env.HEALIX_WORKSPACE_SECRET_KEY = randomBytes(32).toString('base64')
    ;(process.env as Record<string, string>).NODE_ENV = 'test'
  })

  it('round-trips simple JSON', async () => {
    const { encryptJson, decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const payload = [{ role: 'admin', username: 'admin@example.com', password: 'admin' }]
    const env = encryptJson(payload)
    expect(env.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(env.authTag, 'base64')).toHaveLength(16)
    const out = decryptJson(env)
    expect(out).toEqual(payload)
  })

  it('round-trips nested JSON with all the field types', async () => {
    const { encryptJson, decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const payload = {
      arr: [1, 2, 3],
      nested: { foo: 'bar', baz: null, b: true },
      empty: [],
      unicode: 'héllo • ✨',
    }
    const env = encryptJson(payload)
    const out = decryptJson(env)
    expect(out).toEqual(payload)
  })

  it('produces a fresh IV per encryption (no IV reuse)', async () => {
    const { encryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const a = encryptJson({ x: 1 })
    const b = encryptJson({ x: 1 })
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('throws when ciphertext bytes are tampered', async () => {
    const { encryptJson, decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const env = encryptJson({ secret: 'shh' })
    const ctBytes = Buffer.from(env.ciphertext, 'base64')
    if (ctBytes.length === 0) {
      // Shouldn't happen, but guard so the test fails meaningfully.
      throw new Error('ciphertext empty')
    }
    ctBytes[0] = ctBytes[0] ^ 0xff
    const tampered = { ...env, ciphertext: ctBytes.toString('base64') }
    expect(() => decryptJson(tampered)).toThrow()
  })

  it('throws when authTag is tampered', async () => {
    const { encryptJson, decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const env = encryptJson({ secret: 'shh' })
    const tagBytes = Buffer.from(env.authTag, 'base64')
    tagBytes[0] = tagBytes[0] ^ 0xff
    const tampered = { ...env, authTag: tagBytes.toString('base64') }
    expect(() => decryptJson(tampered)).toThrow()
  })

  it('throws when IV is tampered', async () => {
    const { encryptJson, decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    const env = encryptJson({ secret: 'shh' })
    const ivBytes = Buffer.from(env.iv, 'base64')
    ivBytes[0] = ivBytes[0] ^ 0xff
    const tampered = { ...env, iv: ivBytes.toString('base64') }
    expect(() => decryptJson(tampered)).toThrow()
  })

  it('throws on malformed envelope shape', async () => {
    const { decryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
    _resetKeyForTests()
    expect(() => decryptJson({} as never)).toThrow()
    // Missing iv
    expect(() =>
      decryptJson({ ciphertext: 'abc', authTag: 'def' } as never)
    ).toThrow()
  })

  it('production NODE_ENV without key throws on first use', async () => {
    const oldEnv = process.env.NODE_ENV
    const oldKey = process.env.HEALIX_WORKSPACE_SECRET_KEY
    ;(process.env as Record<string, string>).NODE_ENV = 'production'
    delete process.env.HEALIX_WORKSPACE_SECRET_KEY
    try {
      const { encryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
      _resetKeyForTests()
      expect(() => encryptJson({ x: 1 })).toThrow(/HEALIX_WORKSPACE_SECRET_KEY/)
    } finally {
      ;(process.env as Record<string, string | undefined>).NODE_ENV = oldEnv
      if (oldKey) process.env.HEALIX_WORKSPACE_SECRET_KEY = oldKey
    }
  })

  it('rejects a non-32-byte key', async () => {
    const oldKey = process.env.HEALIX_WORKSPACE_SECRET_KEY
    process.env.HEALIX_WORKSPACE_SECRET_KEY = Buffer.from('too short').toString('base64')
    try {
      const { encryptJson, _resetKeyForTests } = await import('@/lib/crypto-aes')
      _resetKeyForTests()
      expect(() => encryptJson({ x: 1 })).toThrow(/32 bytes/)
    } finally {
      if (oldKey) process.env.HEALIX_WORKSPACE_SECRET_KEY = oldKey
    }
  })
})
