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

describe('MemoryStore search', () => {
  let store
  beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
  afterEach(() => { store.close() })

  it('returns empty array when no memories match the query', async () => {
    // Search in a namespace that has no stored memories
    const results = await store.search('empty-ns', 'hello world')
    expect(results).toEqual([])
  })

  it('returns results with a score property', async () => {
    await store.store('ns', 'key1', 'the quick brown fox jumps over the lazy dog')
    const results = await store.search('ns', 'quick fox')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r).toHaveProperty('score')
      expect(typeof r.score).toBe('number')
    }
  })

  it('ranks similar content higher', async () => {
    await store.store('ns', 'cats', 'cats are wonderful furry pets')
    await store.store('ns', 'quantum', 'quantum mechanics wave function')
    const results = await store.search('ns', 'furry cats pets')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].key).toBe('cats')
  })

  it('scopes search to the correct namespace', async () => {
    await store.store('ns1', 'shared', 'shared content about databases')
    await store.store('ns2', 'shared', 'shared content about databases')

    const results = await store.search('ns1', 'databases')
    expect(results.length).toBe(1)
    expect(results[0].namespace).toBe('ns1')
  })

  it('filters by tags', async () => {
    await store.store('ns', 'animals-post', 'dogs and cats are great animals', ['animals'])
    await store.store('ns', 'other-post', 'dogs and cats are great animals', ['other'])

    const results = await store.search('ns', 'dogs cats animals', 10, ['animals'])
    expect(results.length).toBeGreaterThanOrEqual(1)
    for (const r of results) {
      expect(r.tags).toContain('animals')
    }
    expect(results.every(r => r.key === 'animals-post')).toBe(true)
  })

  it('respects limit parameter', async () => {
    await store.store('ns', 'a', 'common words about testing things')
    await store.store('ns', 'b', 'common words about testing stuff')
    await store.store('ns', 'c', 'common words about testing items')

    const results = await store.search('ns', 'common words testing', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('respects offset parameter', async () => {
    await store.store('ns', 'a', 'common words about testing search offset')
    await store.store('ns', 'b', 'common words about testing search offset')
    await store.store('ns', 'c', 'common words about testing search offset')

    const full = await store.search('ns', 'common testing search offset', 10, [], 0)
    const withOffset = await store.search('ns', 'common testing search offset', 10, [], 1)

    expect(withOffset.length).toBe(full.length - 1)
    // The first result after offset should match the second result of full
    if (withOffset.length > 0 && full.length > 1) {
      expect(withOffset[0].key).toBe(full[1].key)
    }
  })

  it('rejects empty query string', async () => {
    await expect(store.search('ns', '')).rejects.toThrow(/query/)
  })

  it('rejects empty namespace', async () => {
    await expect(store.search('', 'some query')).rejects.toThrow(/namespace/)
  })
})
