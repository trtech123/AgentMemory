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
