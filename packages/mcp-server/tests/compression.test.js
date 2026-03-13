import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/embeddings.js', () => {
  function textToVec(text) {
    const vec = new Array(384).fill(0)
    const lower = text.toLowerCase()
    for (let i = 0; i < lower.length; i++) {
      vec[lower.charCodeAt(i) % 384] += 1
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    return norm > 0 ? vec.map(v => v / norm) : vec
  }

  return {
    embed: vi.fn(async (text) => textToVec(text)),
    ensureReady: vi.fn(async () => true),
    isReady: vi.fn(() => true),
    vectorToBuffer: (vec) => Buffer.from(new Float32Array(vec).buffer),
    bufferToVector: (buf) => Array.from(new Float32Array(new Uint8Array(buf).buffer)),
    cosineSimilarity: (a, b) => {
      let dot = 0, nA = 0, nB = 0
      for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; nA += a[i]*a[i]; nB += b[i]*b[i] }
      const d = Math.sqrt(nA) * Math.sqrt(nB)
      return d === 0 ? 0 : dot / d
    },
  }
})

import { MemoryStore } from '../src/store.js'

const longContent = [
  'The authentication system uses JWT tokens for stateless session management.',
  'Each token contains a user ID, role, and expiration timestamp.',
  'Tokens are signed with RS256 using a rotating key pair stored in environment variables.',
  'The refresh token flow uses HTTP-only cookies to prevent XSS attacks.',
  'Rate limiting is applied at the middleware level using a sliding window algorithm.',
  'Failed login attempts are tracked per IP address with exponential backoff.',
  'The password hashing uses bcrypt with a cost factor of 12.',
  'Two-factor authentication supports both TOTP and SMS-based verification.',
  'Session revocation is handled through a Redis-backed blocklist.',
  'The OAuth2 integration supports Google, GitHub, and Microsoft providers.',
  'CORS configuration restricts origins to the frontend domain only.',
  'API keys are hashed with SHA-256 before storage in the database.',
].join(' ')

describe('Context Compression', () => {
  let store
  beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
  afterEach(() => { store.close() })

  describe('auto-summary on store', () => {
    it('generates summary for long content', async () => {
      await store.store('ns', 'long-doc', longContent)
      const recalled = await store.recall('ns', 'long-doc')
      expect(recalled.summary).not.toBeNull()
      expect(recalled.summary.length).toBeLessThan(recalled.content.length)
    })

    it('does not generate summary for short content', async () => {
      await store.store('ns', 'short-doc', 'This is short.')
      const recalled = await store.recall('ns', 'short-doc')
      expect(recalled.summary).toBeNull()
    })

    it('updates summary on update', async () => {
      await store.store('ns', 'doc', longContent)
      const v1 = await store.recall('ns', 'doc')

      const newContent = longContent + ' Additional security measures include IP whitelisting and geo-blocking. Audit logs track all authentication events with full request metadata.'
      await store.update('ns', 'doc', newContent)
      const v2 = await store.recall('ns', 'doc')

      expect(v2.summary).not.toBeNull()
      expect(v2.summary).not.toBe(v1.summary)
    })
  })

  describe('compress()', () => {
    it('compresses text without storing', () => {
      const result = store.compress(longContent)
      expect(result.length).toBeLessThan(longContent.length)
      expect(result.length).toBeGreaterThan(0)
    })

    it('accepts custom ratio', () => {
      const loose = store.compress(longContent, 0.7)
      const tight = store.compress(longContent, 0.2)
      expect(tight.length).toBeLessThan(loose.length)
    })
  })

  describe('snapshot()', () => {
    it('stores with session-snapshot tag', async () => {
      await store.snapshot('session', 'snap-1', longContent)
      const recalled = await store.recall('session', 'snap-1')
      expect(recalled.tags).toContain('session-snapshot')
      expect(recalled.content).toBe(longContent)
      expect(recalled.summary).not.toBeNull()
    })

    it('preserves additional tags', async () => {
      await store.snapshot('session', 'snap-2', longContent, ['auth', 'important'])
      const recalled = await store.recall('session', 'snap-2')
      expect(recalled.tags).toContain('session-snapshot')
      expect(recalled.tags).toContain('auth')
      expect(recalled.tags).toContain('important')
    })

    it('does not duplicate session-snapshot tag', async () => {
      await store.snapshot('session', 'snap-3', longContent, ['session-snapshot'])
      const recalled = await store.recall('session', 'snap-3')
      const count = recalled.tags.filter(t => t === 'session-snapshot').length
      expect(count).toBe(1)
    })
  })

  describe('bulkRecall()', () => {
    beforeEach(async () => {
      await store.store('ns', 'auth', longContent, ['backend'])
      await store.store('ns', 'db', 'Database uses PostgreSQL with connection pooling.', ['backend'])
      await store.store('ns', 'frontend', 'React with TypeScript and Tailwind CSS.', ['frontend'])
    })

    it('recalls by keys and returns merged summary', async () => {
      const result = await store.bulkRecall('ns', ['auth', 'db'])
      expect(result.items).toHaveLength(2)
      expect(result.merged).toContain('[auth]')
      expect(result.merged).toContain('[db]')
      expect(result.stats.memories_count).toBe(2)
    })

    it('recalls by tags', async () => {
      const result = await store.bulkRecall('ns', [], ['backend'])
      expect(result.items).toHaveLength(2)
      expect(result.merged).toContain('[auth]')
      expect(result.merged).toContain('[db]')
    })

    it('returns compression stats', async () => {
      const result = await store.bulkRecall('ns', ['auth', 'db'])
      expect(result.stats).toHaveProperty('original_tokens')
      expect(result.stats).toHaveProperty('compressed_tokens')
      expect(result.stats).toHaveProperty('compression_ratio')
    })

    it('returns empty for no matches', async () => {
      const result = await store.bulkRecall('ns', ['nonexistent'])
      expect(result.items).toHaveLength(0)
      expect(result.merged).toBe('')
    })

    it('throws without keys or tags', async () => {
      await expect(store.bulkRecall('ns', [], [])).rejects.toThrow(/keys or tags/)
    })
  })
})
