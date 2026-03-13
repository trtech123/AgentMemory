import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../src/embeddings.js', () => ({
  embed: vi.fn(async () => null),
  ensureReady: vi.fn(async () => false),
  isReady: vi.fn(() => false),
  vectorToBuffer: (vec) => Buffer.from(new Float32Array(vec).buffer),
  bufferToVector: (buf) => Array.from(new Float32Array(new Uint8Array(buf).buffer)),
  cosineSimilarity: () => 0,
}))

import { MemoryStore } from '../src/store.js'

describe('Atomic Persist', () => {
  let testDir
  let store

  beforeEach(() => {
    testDir = join(tmpdir(), `agentmemory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (store) {
      try { store.close() } catch (_) {}
    }
    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates a valid DB file after persist', async () => {
    store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'hello')
    store.persist()

    const dbPath = join(testDir, 'memories.db')
    expect(existsSync(dbPath)).toBe(true)

    // Verify no temp files left behind
    expect(existsSync(dbPath + '.tmp')).toBe(false)
    expect(existsSync(dbPath + '.bak')).toBe(false)
  })

  it('cleans up stale .bak file before persisting', async () => {
    // Simulate a stale .bak from a prior crash
    const dbPath = join(testDir, 'memories.db')
    const bakPath = dbPath + '.bak'
    writeFileSync(bakPath, 'stale backup data')

    store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'hello')
    store.persist()

    expect(existsSync(bakPath)).toBe(false)
    expect(existsSync(dbPath)).toBe(true)
  })

  it('recovers from .tmp file when DB is missing (crash during rename)', async () => {
    const dbPath = join(testDir, 'memories.db')
    const tmpPath = dbPath + '.tmp'

    // Create a valid DB first, then simulate a crash scenario
    store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'important data')
    store.persist()
    store.close()
    store = null

    // Simulate crash: rename DB to .tmp, delete the DB
    renameSync(dbPath, tmpPath)
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(tmpPath)).toBe(true)

    // Recovery: init should detect .tmp and restore it
    const store2 = new MemoryStore(testDir)
    await store2.init()

    const recalled = await store2.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
    expect(recalled.content).toBe('important data')
    store2.close()
  })

  it('recovers from .bak + .tmp files (crash during swap)', async () => {
    const dbPath = join(testDir, 'memories.db')
    const tmpPath = dbPath + '.tmp'
    const bakPath = dbPath + '.bak'

    // Create initial DB with data
    store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'original data')
    store.persist()
    store.close()
    store = null

    // Simulate crash: DB renamed to .bak, .tmp exists, no DB
    renameSync(dbPath, bakPath)
    writeFileSync(tmpPath, 'incomplete new data')

    // Recovery: should restore .bak as the DB
    const store2 = new MemoryStore(testDir)
    await store2.init()

    const recalled = await store2.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
    expect(recalled.content).toBe('original data')

    // Cleanup files should be gone
    expect(existsSync(tmpPath)).toBe(false)
    expect(existsSync(bakPath)).toBe(false)
    store2.close()
  })
})

describe('close() safety', () => {
  it('does not throw when called twice', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()
    s.close()
    expect(() => s.close()).not.toThrow()
  })

  it('persists dirty data on close', async () => {
    const testDir = join(tmpdir(), `agentmemory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
    let store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'important')
    // Don't call persist() — close should handle it

    // Bypass the auto-persist by closing immediately
    store.close()
    store = null

    // Reopen and verify data is there
    const store2 = new MemoryStore(testDir)
    await store2.init()
    const recalled = await store2.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
    expect(recalled.content).toBe('important')
    store2.close()

    rmSync(testDir, { recursive: true, force: true })
  })

  it('completes even if persist throws', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()
    // Force persist to fail by corrupting _dbPath
    s._dbPath = '/nonexistent/path/db'
    expect(() => s.close()).not.toThrow()
  })
})

describe('persist error isolation', () => {
  it('store() succeeds even if persist fails', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()

    // Monkey-patch persist to throw
    const originalPersist = s.persist.bind(s)
    s.persist = () => { throw new Error('disk full') }

    // store should still succeed (the in-memory write happened)
    const result = await s.store('ns', 'k1', 'data despite disk failure')
    expect(result).toHaveProperty('id')
    expect(result.version).toBe(1)

    // Verify the data is in memory
    s.persist = originalPersist // restore for recall
    const recalled = await s.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
    expect(recalled.content).toBe('data despite disk failure')

    s.close()
  })
})

describe('Debounced Persist', () => {
  let testDir
  let store

  beforeEach(() => {
    testDir = join(tmpdir(), `agentmemory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (store) {
      try { store.close() } catch (_) {}
      store = null
    }
    rmSync(testDir, { recursive: true, force: true })
  })

  it('read operations do not trigger persist', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()
    await s.store('ns', 'k1', 'content')

    let persistCount = 0
    const originalPersist = s.persist.bind(s)
    s.persist = () => { persistCount++; return originalPersist() }

    persistCount = 0 // reset after store's persist

    // These should NOT trigger persist
    await s.recall('ns', 'k1')
    await s.search('ns', 'content')
    await s.list('ns')
    await s.getStats()
    await s.summarize('ns')
    await s.bulkRecall('ns', ['k1'])

    expect(persistCount).toBe(0)
    s.close()
  })

  it('write operations set dirty flag', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()

    expect(s._dirty).toBeFalsy()
    await s.store('ns', 'k1', 'content')
    expect(s._dirty).toBe(true)

    s.close()
  })

  it('close() persists if dirty', async () => {
    store = new MemoryStore(testDir)
    await store.init()
    await store.store('ns', 'k1', 'dirty data')

    // close should persist
    store.close()
    store = null

    // Verify
    const store2 = new MemoryStore(testDir)
    await store2.init()
    const recalled = await store2.recall('ns', 'k1')
    expect(recalled).not.toBeNull()
    store2.close()
  })
})
