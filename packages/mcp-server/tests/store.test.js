import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock embeddings to avoid loading the real ML model
// Produces deterministic vectors: texts with overlapping characters → closer vectors
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

describe('MemoryStore', () => {
  let store
  beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
  afterEach(() => { store.close() })

  describe('store()', () => {
    it('stores a memory and returns metadata', async () => {
      const result = await store.store('ns', 'key1', 'hello world')
      expect(result).toHaveProperty('id')
      expect(result.namespace).toBe('ns')
      expect(result.key).toBe('key1')
      expect(result.version).toBe(1)
      expect(result).toHaveProperty('tokens')
      expect(result.tokens).toBeGreaterThan(0)
    })

    it('stores with tags and metadata', async () => {
      const result = await store.store('ns', 'key1', 'content', ['tag1', 'tag2'], { author: 'test' })
      expect(result.version).toBe(1)

      const recalled = await store.recall('ns', 'key1')
      expect(recalled.tags).toEqual(['tag1', 'tag2'])
      expect(recalled.metadata).toEqual({ author: 'test' })
    })

    it('upserts on duplicate key (should update to version 2)', async () => {
      const r1 = await store.store('ns', 'key1', 'version one')
      expect(r1.version).toBe(1)

      const r2 = await store.store('ns', 'key1', 'version two')
      expect(r2.version).toBe(2)

      const recalled = await store.recall('ns', 'key1')
      expect(recalled.content).toBe('version two')
      expect(recalled.version).toBe(2)
    })
  })

  describe('recall()', () => {
    it('returns null for nonexistent key', async () => {
      const result = await store.recall('ns', 'nonexistent')
      expect(result).toBeNull()
    })

    it('returns the stored memory with correct content/namespace/key', async () => {
      await store.store('myns', 'mykey', 'my content here')
      const result = await store.recall('myns', 'mykey')
      expect(result).not.toBeNull()
      expect(result.namespace).toBe('myns')
      expect(result.key).toBe('mykey')
      expect(result.content).toBe('my content here')
    })

    it('recalls a specific version', async () => {
      await store.store('ns', 'key1', 'first version content')
      await store.store('ns', 'key1', 'second version content')

      const v1 = await store.recall('ns', 'key1', 1)
      expect(v1.content).toBe('first version content')
      expect(v1.version).toBe(1)

      const v2 = await store.recall('ns', 'key1', 2)
      expect(v2.content).toBe('second version content')
      expect(v2.version).toBe(2)
    })
  })

  describe('update()', () => {
    it('creates if not exists', async () => {
      const result = await store.update('ns', 'newkey', 'new content')
      expect(result.version).toBe(1)

      const recalled = await store.recall('ns', 'newkey')
      expect(recalled).not.toBeNull()
      expect(recalled.content).toBe('new content')
    })

    it('increments version', async () => {
      await store.store('ns', 'key1', 'v1')
      const r2 = await store.update('ns', 'key1', 'v2')
      expect(r2.version).toBe(2)

      const r3 = await store.update('ns', 'key1', 'v3')
      expect(r3.version).toBe(3)
    })

    it('merges metadata', async () => {
      await store.store('ns', 'key1', 'content', [], { a: 1 })
      await store.update('ns', 'key1', 'content updated', undefined, { b: 2 })

      const recalled = await store.recall('ns', 'key1')
      expect(recalled.metadata).toEqual({ a: 1, b: 2 })
    })

    it('replaces tags when provided', async () => {
      await store.store('ns', 'key1', 'content', ['old-tag'])
      await store.update('ns', 'key1', 'content updated', ['new-tag'])

      const recalled = await store.recall('ns', 'key1')
      expect(recalled.tags).toEqual(['new-tag'])
    })
  })

  describe('forget()', () => {
    it('returns false for nonexistent key', async () => {
      const result = await store.forget('ns', 'nonexistent')
      expect(result).toBe(false)
    })

    it('deletes the memory (recall returns null after)', async () => {
      await store.store('ns', 'key1', 'some content')
      const result = await store.forget('ns', 'key1')
      expect(result).toBe(true)

      const recalled = await store.recall('ns', 'key1')
      expect(recalled).toBeNull()
    })

    it('deletes versions too', async () => {
      await store.store('ns', 'key1', 'v1')
      await store.store('ns', 'key1', 'v2')
      await store.forget('ns', 'key1')

      const recalled = await store.recall('ns', 'key1', 1)
      expect(recalled).toBeNull()
    })
  })

  describe('list()', () => {
    it('returns empty array for empty namespace', async () => {
      const result = await store.list('empty-ns')
      expect(result).toEqual([])
    })

    it('lists memories sorted by updated_at desc', async () => {
      await store.store('ns', 'alpha', 'first')
      await store.store('ns', 'beta', 'second')
      // Update alpha so it gets the most recent updated_at
      await store.update('ns', 'alpha', 'first updated')

      const result = await store.list('ns')
      expect(result).toHaveLength(2)
      // Most recently updated should be first
      expect(result[0].key).toBe('alpha')
      expect(result[1].key).toBe('beta')
    })

    it('filters by prefix', async () => {
      await store.store('ns', 'project/readme', 'readme content')
      await store.store('ns', 'project/config', 'config content')
      await store.store('ns', 'notes/daily', 'daily notes')

      const result = await store.list('ns', 'project/')
      expect(result).toHaveLength(2)
      expect(result.every(m => m.key.startsWith('project/'))).toBe(true)
    })

    it('filters by tags', async () => {
      await store.store('ns', 'key1', 'content1', ['important'])
      await store.store('ns', 'key2', 'content2', ['trivial'])
      await store.store('ns', 'key3', 'content3', ['important', 'urgent'])

      const result = await store.list('ns', undefined, ['important'])
      expect(result).toHaveLength(2)
      expect(result.every(m => m.tags.includes('important'))).toBe(true)
    })

    it('paginates with limit and offset', async () => {
      await store.store('ns', 'a', 'content a')
      await store.store('ns', 'b', 'content b')
      await store.store('ns', 'c', 'content c')
      await store.store('ns', 'd', 'content d')

      const page1 = await store.list('ns', undefined, [], 2, 0)
      expect(page1).toHaveLength(2)

      const page2 = await store.list('ns', undefined, [], 2, 2)
      expect(page2).toHaveLength(2)

      // Pages should not overlap
      const page1Keys = page1.map(m => m.key)
      const page2Keys = page2.map(m => m.key)
      expect(page1Keys.every(k => !page2Keys.includes(k))).toBe(true)
    })
  })

  describe('validation', () => {
    it('rejects empty namespace', async () => {
      await expect(store.store('', 'key', 'content')).rejects.toThrow(/namespace/)
    })

    it('rejects empty key', async () => {
      await expect(store.store('ns', '', 'content')).rejects.toThrow(/key/)
    })

    it('rejects namespace over 255 chars', async () => {
      const longNs = 'a'.repeat(256)
      await expect(store.store(longNs, 'key', 'content')).rejects.toThrow(/255/)
    })

    it('rejects content over 100k chars', async () => {
      const longContent = 'x'.repeat(100001)
      await expect(store.store('ns', 'key', longContent)).rejects.toThrow(/100,000/)
    })
  })

  describe('usage log pruning', () => {
    it('prunes usage logs older than 90 days on init', async () => {
      // Insert an old log entry, re-init, verify it's pruned
      const db = store._db
      db.run(
        "INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)",
        ['store', 'ns', 100, '2020-01-01T00:00:00.000Z']
      )
      // Verify it's there
      const before = db.prepare("SELECT COUNT(*) as count FROM usage_log WHERE created_at < '2021-01-01'")
      before.step()
      expect(before.get()[0]).toBe(1)
      before.free()

      // Re-init triggers pruning
      store._initSchema()

      // Old entry should be pruned
      const after = db.prepare("SELECT COUNT(*) as count FROM usage_log WHERE created_at < '2021-01-01'")
      after.step()
      expect(after.get()[0]).toBe(0)
      after.free()
    })
  })
})
