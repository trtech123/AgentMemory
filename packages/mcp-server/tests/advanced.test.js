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

describe('Namespaces', () => {
  let store
  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('listNamespaces returns namespaces with correct counts', async () => {
    await store.store('alpha', 'k1', 'content1')
    await store.store('alpha', 'k2', 'content2')
    await store.store('beta', 'k1', 'content3')

    const namespaces = await store.listNamespaces()
    expect(namespaces).toHaveLength(2)

    const alpha = namespaces.find(n => n.namespace === 'alpha')
    const beta = namespaces.find(n => n.namespace === 'beta')
    expect(alpha.count).toBe(2)
    expect(beta.count).toBe(1)
  })

  it('deleteNamespace dry run (confirm=false) returns count without deleting', async () => {
    await store.store('ns', 'k1', 'content1')
    await store.store('ns', 'k2', 'content2')

    const result = await store.deleteNamespace('ns', false)
    expect(result.confirmed).toBe(false)
    expect(result.count).toBe(2)

    // Memories should still exist
    const recalled = await store.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
  })

  it('deleteNamespace with confirm=true deletes everything', async () => {
    await store.store('ns', 'k1', 'content1')
    await store.store('ns', 'k2', 'content2')

    const result = await store.deleteNamespace('ns', true)
    expect(result.confirmed).toBe(true)
    expect(result.deleted).toBe(2)

    // Memories should be gone
    const r1 = await store.recall('ns', 'k1')
    const r2 = await store.recall('ns', 'k2')
    expect(r1).toBeNull()
    expect(r2).toBeNull()

    // Namespace should no longer appear
    const namespaces = await store.listNamespaces()
    expect(namespaces.find(n => n.namespace === 'ns')).toBeUndefined()
  })
})

describe('Export/Import', () => {
  let store
  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('export then import into a fresh store works (roundtrip)', async () => {
    await store.store('ns', 'k1', 'hello world', ['greeting'], { author: 'test' })
    await store.store('ns', 'k2', 'goodbye world', ['farewell'])

    const exported = await store.exportNamespace('ns')
    expect(exported.count).toBe(2)
    expect(exported.export_version).toBe(1)

    // Import into a fresh store
    const store2 = new MemoryStore(':memory:')
    try {
      const result = await store2.importMemories(exported)
      expect(result.imported).toBe(2)
      expect(result.skipped).toBe(0)

      const recalled = await store2.recall('ns', 'k1')
      expect(recalled).not.toBeNull()
      expect(recalled.content).toBe('hello world')
      expect(recalled.tags).toEqual(['greeting'])
      expect(recalled.metadata).toEqual({ author: 'test' })
    } finally {
      store2.close()
    }
  })

  it('import with skip mode skips existing keys', async () => {
    await store.store('ns', 'k1', 'original content')

    const exported = await store.exportNamespace('ns')

    // Modify the exported data content to detect if it gets overwritten
    exported.memories[0].content = 'modified content'

    const result = await store.importMemories(exported, 'skip')
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(0)

    // Content should remain original
    const recalled = await store.recall('ns', 'k1')
    expect(recalled.content).toBe('original content')
  })

  it('import with overwrite mode replaces existing keys', async () => {
    await store.store('ns', 'k1', 'original content')

    const exported = await store.exportNamespace('ns')
    exported.memories[0].content = 'overwritten content'

    const result = await store.importMemories(exported, 'overwrite')
    expect(result.overwritten).toBe(1)
    expect(result.imported).toBe(1)

    const recalled = await store.recall('ns', 'k1')
    expect(recalled.content).toBe('overwritten content')
  })

  it('export includes version history', async () => {
    await store.store('ns', 'k1', 'version one content')
    await store.update('ns', 'k1', 'version two content')

    const exported = await store.exportNamespace('ns')
    expect(exported.memories).toHaveLength(1)
    expect(exported.memories[0].versions).toHaveLength(2)
    expect(exported.memories[0].versions[0].version).toBe(1)
    expect(exported.memories[0].versions[1].version).toBe(2)
  })

  it('export all namespaces when namespace omitted', async () => {
    await store.store('ns1', 'k1', 'content in ns1')
    await store.store('ns2', 'k2', 'content in ns2')

    const exported = await store.exportNamespace()
    expect(exported.namespace).toBe('all')
    expect(exported.count).toBe(2)

    const namespaces = exported.memories.map(m => m.namespace)
    expect(namespaces).toContain('ns1')
    expect(namespaces).toContain('ns2')
  })

  it('rejects unsupported export version', async () => {
    const badData = { export_version: 99, memories: [] }
    await expect(store.importMemories(badData)).rejects.toThrow(/Unsupported export version/)
  })
})

describe('Summarize', () => {
  let store
  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('returns null for empty/nonexistent namespace', async () => {
    const result = await store.summarize('nonexistent')
    expect(result).toBeNull()
  })

  it('returns summary with correct tag grouping', async () => {
    await store.store('ns', 'tagged1', 'content one', ['docs'])
    await store.store('ns', 'tagged2', 'content two', ['docs', 'important'])
    await store.store('ns', 'untagged1', 'content three')

    const summary = await store.summarize('ns')
    expect(summary).not.toBeNull()
    expect(summary.namespace).toBe('ns')
    expect(summary.total_memories).toBe(3)

    // by_tag should contain keys grouped by tag
    expect(summary.by_tag).toHaveProperty('docs')
    expect(summary.by_tag.docs).toContain('tagged1')
    expect(summary.by_tag.docs).toContain('tagged2')
    expect(summary.by_tag).toHaveProperty('important')
    expect(summary.by_tag.important).toContain('tagged2')

    // untagged should list keys with no tags
    expect(summary.untagged).toContain('untagged1')
    expect(summary.untagged).not.toContain('tagged1')
    expect(summary.untagged).not.toContain('tagged2')
  })
})

describe('Stats', () => {
  let store
  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('tracks token usage on store', async () => {
    const statsBefore = await store.getStats()
    expect(statsBefore.total_tokens_stored).toBe(0)

    await store.store('ns', 'k1', 'some content for token counting')

    const statsAfter = await store.getStats()
    expect(statsAfter.total_tokens_stored).toBeGreaterThan(0)
  })

  it('tracks tokens saved on recall', async () => {
    await store.store('ns', 'k1', 'content that will be recalled later')

    const statsBefore = await store.getStats()
    const savedBefore = statsBefore.total_tokens_saved

    await store.recall('ns', 'k1')

    const statsAfter = await store.getStats()
    expect(statsAfter.total_tokens_saved).toBeGreaterThan(savedBefore)
  })
})
