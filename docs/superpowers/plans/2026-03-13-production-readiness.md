# AgentMemory v0.4.0 Production Readiness — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden AgentMemory for open-source npm distribution — fix broken tests, add atomic writes, improve error handling, optimize persistence, switch to binary embeddings, and update documentation.

**Architecture:** Single-file MCP server (`index.js`) backed by a storage engine (`store.js`) using sql.js (WASM SQLite). All changes are internal to these two files plus tests. No new dependencies.

**Tech Stack:** Node.js, sql.js, Transformers.js, vitest, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-13-agentmemory-production-readiness-design.md`

---

## Chunk 1: Fix Tests + Quick Cleanups (Phase 1)

### Task 1: Fix test suite — add missing `store.init()` calls

**Files:**
- Modify: `packages/mcp-server/tests/store.test.js:35`
- Modify: `packages/mcp-server/tests/search.test.js:35`
- Modify: `packages/mcp-server/tests/advanced.test.js:35,87,178,211`
- Modify: `packages/mcp-server/tests/compression.test.js:48`

- [ ] **Step 1: Fix `store.test.js` — add `await store.init()` to beforeEach**

In `tests/store.test.js` line 35, change:
```js
beforeEach(() => { store = new MemoryStore(':memory:') })
```
to:
```js
beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
```

- [ ] **Step 2: Fix `search.test.js` — same change**

In `tests/search.test.js` line 35, change:
```js
beforeEach(() => { store = new MemoryStore(':memory:') })
```
to:
```js
beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
```

- [ ] **Step 3: Fix `advanced.test.js` — all four `beforeEach` hooks**

Lines 35, 87, 178, 211 all have the same pattern. Change each from:
```js
beforeEach(() => { store = new MemoryStore(':memory:') })
```
to:
```js
beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
```

Also fix line 99 in the Export/Import `roundtrip` test — `store2` needs `init()`.
Insert `await store2.init()` on a new line between line 99 (`const store2 = new MemoryStore(':memory:')`) and line 100 (`try {`):
```js
const store2 = new MemoryStore(':memory:')
await store2.init()
try {
```

- [ ] **Step 4: Fix `compression.test.js` — same change**

In `tests/compression.test.js` line 48, change:
```js
beforeEach(() => { store = new MemoryStore(':memory:') })
```
to:
```js
beforeEach(async () => { store = new MemoryStore(':memory:'); await store.init() })
```

Also the nested `beforeEach` at line 118 that stores test data — verify it already awaits correctly (it does: `beforeEach(async () => { await store.store(...) })`). No change needed there.

- [ ] **Step 5: Run full test suite to verify 75/75 pass**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All 6 test files pass, 75 tests total, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/tests/
git commit -m "fix: add missing store.init() to all test beforeEach hooks

All 48 failing tests were caused by MemoryStore never being initialized
in test setup. The constructor sets this._db = null, and init() must be
called to create the actual sql.js database instance."
```

### Task 2: Fix SQL string interpolation

**Files:**
- Modify: `packages/mcp-server/src/store.js:165`

- [ ] **Step 1: Write a test for usage log pruning**

Add to `tests/store.test.js` inside the main `describe('MemoryStore')` block:

```js
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
```

- [ ] **Step 2: Run test to verify it passes (establishes the pruning contract)**

Run: `cd packages/mcp-server && npx vitest run tests/store.test.js`
Expected: PASS

- [ ] **Step 3: Fix the SQL interpolation in `store.js` line 165**

Change:
```js
db.run(`DELETE FROM usage_log WHERE created_at < datetime('now', '-${USAGE_LOG_TTL_DAYS} days')`)
```
to:
```js
db.run(`DELETE FROM usage_log WHERE created_at < datetime('now', '-' || ? || ' days')`, [USAGE_LOG_TTL_DAYS])
```

- [ ] **Step 4: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/store.test.js
git commit -m "fix: parameterize SQL usage log TTL to eliminate string interpolation"
```

---

## Chunk 2: Atomic Writes + Schema Fixes (Phase 2)

### Task 3: Add version index to schema

**Files:**
- Modify: `packages/mcp-server/src/store.js:124` (after memory_versions CREATE TABLE)

- [ ] **Step 1: Add the missing index**

After line 124 in `store.js` (after the `memory_versions` CREATE TABLE), add:
```js
db.run(`CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, version)`)
```

- [ ] **Step 2: Run tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass (index is additive, breaks nothing).

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/store.js
git commit -m "perf: add missing index on memory_versions(memory_id, version)"
```

### Task 4: Implement atomic writes with Windows-safe rename

**Files:**
- Modify: `packages/mcp-server/src/store.js:10` (add `renameSync`, `unlinkSync` imports)
- Modify: `packages/mcp-server/src/store.js:85-89` (rewrite `persist()`)
- Modify: `packages/mcp-server/src/store.js:51-69` (add recovery logic to `init()`)
- Create: `packages/mcp-server/tests/persist.test.js`

- [ ] **Step 1: Write failing tests for atomic writes**

Create `tests/persist.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js`
Expected: Some tests fail (recovery logic doesn't exist yet, .tmp/.bak not cleaned up).

- [ ] **Step 3: Add `renameSync` and `unlinkSync` to imports**

In `store.js` line 10, change:
```js
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
```
to:
```js
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
```

- [ ] **Step 4: Add recovery logic to `init()`**

Add this at the beginning of `init()`, after the `if (this._dbPath === ':memory:')` check but before loading the DB, inside the `else` block:

```js
// Recovery from interrupted persist
const tmpPath = this._dbPath + '.tmp'
const bakPath = this._dbPath + '.bak'

if (existsSync(bakPath) && existsSync(tmpPath)) {
  // Crash during swap: .bak is the good copy, .tmp is incomplete
  renameSync(bakPath, this._dbPath)
  unlinkSync(tmpPath)
} else if (existsSync(bakPath) && !existsSync(tmpPath)) {
  // Swap completed but .bak cleanup failed
  unlinkSync(bakPath)
} else if (existsSync(tmpPath) && !existsSync(bakPath) && !existsSync(this._dbPath)) {
  // Write completed but rename never started
  renameSync(tmpPath, this._dbPath)
}
```

- [ ] **Step 5: Rewrite `persist()` with atomic three-step swap**

Replace the `persist()` method (lines 85-89) with:

```js
persist() {
  if (!this._db || this._dbPath === ':memory:') return

  const tmpPath = this._dbPath + '.tmp'
  const bakPath = this._dbPath + '.bak'

  // Clean up stale .bak from prior crash
  if (existsSync(bakPath)) {
    try { unlinkSync(bakPath) } catch (_) {}
  }

  // Step 1: Write new data to temp file
  writeFileSync(tmpPath, Buffer.from(this._db.export()))

  // Step 2: If DB exists, move it to backup (Windows-safe: no overwrite)
  if (existsSync(this._dbPath)) {
    renameSync(this._dbPath, bakPath)
  }

  // Step 3: Move temp to DB path
  renameSync(tmpPath, this._dbPath)

  // Step 4: Clean up backup
  if (existsSync(bakPath)) {
    try { unlinkSync(bakPath) } catch (_) {}
  }
}
```

- [ ] **Step 6: Run persist tests**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js`
Expected: All 4 tests pass.

- [ ] **Step 7: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/persist.test.js
git commit -m "feat: atomic writes with Windows-safe three-step rename and crash recovery

Persist now writes to .tmp, renames DB to .bak, renames .tmp to DB,
then cleans up .bak. init() recovers from any crash state."
```

---

## Chunk 3: Error Handling (Phase 3)

### Task 5: Add double-close guard and error handling to `store.close()`

**Files:**
- Modify: `packages/mcp-server/src/store.js:793-801` (rewrite `close()`)

- [ ] **Step 1: Write failing tests**

Add to `tests/persist.test.js`:

```js
describe('close() safety', () => {
  it('does not throw when called twice', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()
    s.close()
    expect(() => s.close()).not.toThrow()
  })

  it('persists dirty data on close', async () => {
    store = new MemoryStore(testDir)
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
  })

  it('completes even if persist throws', async () => {
    const s = new MemoryStore(':memory:')
    await s.init()
    // Force persist to fail by corrupting _dbPath
    s._dbPath = '/nonexistent/path/db'
    expect(() => s.close()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to see which tests fail**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js`
Expected: "does not throw when called twice" fails (double-close on sql.js throws).

- [ ] **Step 3: Rewrite `close()`**

Replace `close()` method (lines 793-801) with:

```js
close() {
  if (!this._db) return // double-close guard
  if (this._persistInterval) {
    clearInterval(this._persistInterval)
    this._persistInterval = null
  }
  try {
    this.persist()
  } catch (err) {
    console.error('Persist failed on close:', err?.message || String(err))
  }
  this._db.close()
  this._db = null
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/persist.test.js
git commit -m "fix: add double-close guard and error handling to store.close()"
```

### Task 6: Add persist error isolation and global error handlers

**Files:**
- Modify: `packages/mcp-server/src/store.js` (wrap persist calls in try/catch)
- Modify: `packages/mcp-server/src/index.js:700-701` (signal handlers + global error handlers)

- [ ] **Step 1: Write test for persist error isolation**

Add to `tests/persist.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "persist error isolation"`
Expected: FAIL — `store()` currently lets `persist()` error propagate.

- [ ] **Step 3: Wrap all `this.persist()` calls in store.js with try/catch**

Find every `this.persist()` call in `store.js` (lines 332, 373, 414, 440, 453, 502, 520, 601, 779) and wrap each one:

```js
try { this.persist() } catch (_) { this._persistFailed = true }
```

Also add `this._persistFailed = false` to the constructor (after `this._persistInterval = null`).

> **Note:** `_persistFailed` is set here but not retried until Task 7 adds the retry logic to the safety interval. This is intentional — the flag is dead code between Task 6 and Task 7 completion.

And in `persist()` method, add at the end (after successful write):
```js
this._persistFailed = false
```

- [ ] **Step 4: Run persist isolation test**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "persist error isolation"`
Expected: PASS

- [ ] **Step 5: Update `index.js` — add global error handlers and wrap signal handlers**

Replace lines 700-701 in `index.js`:
```js
process.on('SIGINT', () => { store.close(); process.exit(0) })
process.on('SIGTERM', () => { store.close(); process.exit(0) })
```

With:
```js
// Global error handlers — close() is sync so it works in exit handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || String(err))
  try { store.close() } catch (_) {}
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || String(reason))
  try { store.close() } catch (_) {}
  process.exit(1)
})

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { store.close() } catch (_) {}
    process.exit(0)
  })
}
```

- [ ] **Step 6: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js packages/mcp-server/tests/persist.test.js
git commit -m "fix: isolate persist errors from operations, add global error handlers

persist() failures no longer propagate to callers. _persistFailed flag
triggers retry on next safety interval. Global uncaughtException and
unhandledRejection handlers ensure graceful shutdown."
```

---

## Chunk 4: Debounced Persist (Phase 4)

### Task 7: Replace persist-on-every-op with debounced dirty-flag system

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add `_markDirty()`, modify `init()`, modify `close()`, remove persist calls from reads)
- Modify: `packages/mcp-server/tests/persist.test.js`

- [ ] **Step 1: Write tests for debounced persist behavior**

Add to `tests/persist.test.js`:

```js
describe('Debounced Persist', () => {
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
```

- [ ] **Step 2: Run tests — they should fail**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "Debounced Persist"`
Expected: FAIL — reads still call persist, no `_dirty` flag exists.

- [ ] **Step 3: Add `_markDirty()` method and initialize state in constructor**

Add to constructor (after `this._persistFailed = false`):
```js
this._dirty = false
this._debounceTimer = null
```

Add method to `MemoryStore` class:
```js
_markDirty() {
  this._dirty = true
  if (this._debounceTimer) clearTimeout(this._debounceTimer)
  this._debounceTimer = setTimeout(() => {
    try { this.persist() } catch (_) { this._persistFailed = true }
  }, 1000)
}
```

- [ ] **Step 4: Modify the 5-second safety interval in `init()`**

Change line 68 from:
```js
this._persistInterval = setInterval(() => this.persist(), 5000)
```
to:
```js
this._persistInterval = setInterval(() => {
  if (this._dirty || this._persistFailed) {
    try {
      this.persist()
      this._dirty = false
      this._persistFailed = false
    } catch (_) {
      this._persistFailed = true
    }
  }
}, 5000)
```

- [ ] **Step 5: Replace all `this.persist()` / `try { this.persist() }` calls in write operations with `this._markDirty()`**

In `store.js`, find these lines and replace:

- `store()` (line ~332): replace `try { this.persist() } catch (_) { this._persistFailed = true }` with `this._markDirty()`
- `update()` (line ~502): same replacement
- `forget()` (line ~520): same replacement
- `deleteNamespace()` (line ~601): same replacement

- [ ] **Step 6: Remove all persist/try-persist calls from read operations**

Remove the persist-related lines from:
- `search()` — two locations: embedding path (line ~373) and TF-IDF path (line ~414)
- `recall()` — two locations (lines ~440, ~453)
- `bulkRecall()` (line ~779)

Keep the `_logUsage()` calls — just remove the `try { this.persist() } catch` lines that follow them.

- [ ] **Step 7: Update `close()` to clear debounce timer and reset dirty flag**

Replace `close()` with:
```js
close() {
  if (!this._db) return
  if (this._debounceTimer) {
    clearTimeout(this._debounceTimer)
    this._debounceTimer = null
  }
  if (this._persistInterval) {
    clearInterval(this._persistInterval)
    this._persistInterval = null
  }
  if (this._dirty) {
    try {
      this.persist()
      this._dirty = false
    } catch (err) {
      console.error('Persist failed on close:', err?.message || String(err))
    }
  }
  this._db.close()
  this._db = null
}
```

- [ ] **Step 8: Also clear `_dirty` and `_persistFailed` in the `persist()` method on success**

At the end of `persist()`, after the final `.bak` cleanup, add:
```js
this._dirty = false
this._persistFailed = false
```

- [ ] **Step 9: Run debounced persist tests**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "Debounced Persist"`
Expected: All 3 tests pass.

- [ ] **Step 10: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/persist.test.js
git commit -m "perf: replace persist-on-every-op with debounced dirty-flag system

Read operations no longer trigger persist. Write operations set a dirty
flag and schedule a debounced persist after 1 second. Safety interval
every 5 seconds persists if dirty or if a prior persist failed."
```

---

## Chunk 5: Binary Embeddings + Cache (Phase 5)

### Task 8: Switch embeddings from JSON text to binary BLOBs

**Files:**
- Modify: `packages/mcp-server/src/store.js:254-261` (`_upsertEmbedding`)
- Modify: `packages/mcp-server/src/store.js:362-364` (search — read path)

- [ ] **Step 1: Write test for binary embedding round-trip**

Add to `tests/search.test.js`:

```js
describe('Binary embedding storage', () => {
  it('stores and retrieves embeddings correctly via binary BLOBs', async () => {
    await store.store('ns', 'doc1', 'the quick brown fox jumps over the lazy dog')
    await store.store('ns', 'doc2', 'quantum physics wave particle duality')

    // Search should still find the right document
    const results = await store.search('ns', 'quick brown fox')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].key).toBe('doc1')
    expect(results[0]).toHaveProperty('score')
    expect(typeof results[0].score).toBe('number')
  })
})
```

- [ ] **Step 2: Run test — it passes with JSON too, establishing the contract**

Run: `cd packages/mcp-server && npx vitest run tests/search.test.js -t "Binary embedding"`
Expected: PASS

- [ ] **Step 3: Change `_upsertEmbedding` to use `vectorToBuffer`**

Replace lines 254-261:
```js
_upsertEmbedding(memoryId, vector) {
  // Store embedding as JSON text in the memories table
  const embeddingJson = JSON.stringify(vector)
  queryRun(this._db,
    'UPDATE memories SET embedding = ? WHERE id = ?',
    [embeddingJson, memoryId]
  )
}
```

With:
```js
_upsertEmbedding(memoryId, vector) {
  const blob = vectorToBuffer(vector)
  queryRun(this._db,
    'UPDATE memories SET embedding = ? WHERE id = ?',
    [blob, memoryId]
  )
}
```

- [ ] **Step 4: Change search read path to use `bufferToVector`**

In `search()`, replace line ~363:
```js
const storedVec = JSON.parse(row.embedding)
```
with:
```js
const storedVec = bufferToVector(row.embedding)
```

- [ ] **Step 5: Run search tests**

Run: `cd packages/mcp-server && npx vitest run tests/search.test.js`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/search.test.js
git commit -m "feat: switch embeddings from JSON text to binary BLOBs

Activates vectorToBuffer/bufferToVector (previously dead code).
Cuts embedding storage ~33% and eliminates JSON parse overhead on search.
BREAKING: existing databases with JSON embeddings are incompatible."
```

### Task 9: Add in-memory embedding cache

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add cache to constructor, populate on search, invalidate on writes)

- [ ] **Step 1: Write tests for cache invalidation**

Add to `tests/search.test.js`:

```js
describe('Embedding cache', () => {
  it('new memories appear in search results after store', async () => {
    await store.store('ns', 'doc1', 'cats are wonderful furry pets')

    // First search populates cache
    const r1 = await store.search('ns', 'cats pets')
    expect(r1).toHaveLength(1)

    // Store new memory — should invalidate cache
    await store.store('ns', 'doc2', 'dogs are loyal furry companions')

    // Second search should include the new memory
    const r2 = await store.search('ns', 'furry pets companions')
    expect(r2.length).toBeGreaterThanOrEqual(2)
  })

  it('deleted memories disappear from search results', async () => {
    await store.store('ns', 'doc1', 'temporary data to be deleted')
    await store.store('ns', 'doc2', 'permanent data to keep')

    // Populate cache
    await store.search('ns', 'data')

    // Delete — should invalidate cache
    await store.forget('ns', 'doc1')

    const results = await store.search('ns', 'temporary deleted data')
    expect(results.every(r => r.key !== 'doc1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — they pass even without cache (establishing behavior contract)**

Run: `cd packages/mcp-server && npx vitest run tests/search.test.js -t "Embedding cache"`
Expected: PASS

- [ ] **Step 3: Add cache to constructor and invalidation to write methods**

Add to constructor (after `this._debounceTimer = null`):
```js
this._embeddingCache = new Map() // namespace -> Map<memoryId, Float32Array>
this._batchMode = false
```

Add invalidation helper:
```js
_invalidateEmbeddingCache(namespace) {
  if (!this._batchMode) {
    this._embeddingCache.delete(namespace)
  }
}
```

Add cache invalidation calls to:
- `store()` — after the INSERT: `this._invalidateEmbeddingCache(namespace)`
- `update()` — after the UPDATE: `this._invalidateEmbeddingCache(namespace)`
- `forget()` — after the DELETEs: `this._invalidateEmbeddingCache(namespace)`
- `deleteNamespace()` — after the DELETEs: `this._invalidateEmbeddingCache(namespace)`

- [ ] **Step 4: Modify `search()` to use cache**

In the embedding search path, replace:
```js
const rows = queryAll(this._db, sql, params)

if (rows.length > 0) {
  const scored = rows.map(row => {
    const storedVec = bufferToVector(row.embedding)
    const score = cosineSimilarity(queryVec, storedVec)
    return { ...this._formatRow(row), score }
  })
```

With:
```js
// Build/use embedding cache for this namespace
if (!this._embeddingCache.has(namespace)) {
  const allRows = queryAll(this._db,
    'SELECT id, embedding FROM memories WHERE namespace = ? AND embedding IS NOT NULL',
    [namespace]
  )
  const nsCache = new Map()
  for (const r of allRows) {
    nsCache.set(r.id, bufferToVector(r.embedding))
  }
  this._embeddingCache.set(namespace, nsCache)
}
const nsCache = this._embeddingCache.get(namespace)

const rows = queryAll(this._db, sql, params)

if (rows.length > 0) {
  const scored = rows.map(row => {
    const storedVec = nsCache.get(row.id) || bufferToVector(row.embedding)
    const score = cosineSimilarity(queryVec, storedVec)
    return { ...this._formatRow(row), score }
  })
```

- [ ] **Step 5: Add batch mode to `importMemories()`**

In `importMemories()`, wrap the import loop:

Before the `for` loop, add:
```js
this._batchMode = true
const affectedNamespaces = new Set()
```

Inside the loop, after each `store()` call, add:
```js
affectedNamespaces.add(memory.namespace)
```

After the `for` loop, add:
```js
this._batchMode = false
for (const ns of affectedNamespaces) {
  this._embeddingCache.delete(ns)
}
```

- [ ] **Step 6: Run all search and advanced tests**

Run: `cd packages/mcp-server && npx vitest run tests/search.test.js tests/advanced.test.js`
Expected: All tests pass.

- [ ] **Step 7: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/search.test.js
git commit -m "perf: add in-memory embedding cache with invalidation

Cache is populated on first search per namespace, invalidated on writes.
Batch mode suppresses invalidation during import, rebuilds once at end.
Eliminates repeated SQLite reads and buffer-to-vector conversions."
```

### Task 10: Add old format detection

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add check in `init()`)

- [ ] **Step 1: Write test**

Add to `tests/persist.test.js`:

```js
describe('Old format detection', () => {
  it('detects JSON embeddings and throws with upgrade instructions', async () => {
    // Create a DB with JSON-style embedding (simulating v0.3.0 format)
    store = new MemoryStore(testDir)
    await store.init()

    // Manually insert a row with a JSON string embedding (old format)
    const db = store._db
    db.run(`INSERT INTO memories (id, namespace, key, content, embedding, version, created_at, updated_at)
            VALUES ('test1', 'ns', 'k1', 'content', '[0.1, 0.2, 0.3]', 1, datetime('now'), datetime('now'))`)
    store.persist()
    store.close()
    store = null

    // Reopen — should detect old format
    const store2 = new MemoryStore(testDir)
    await expect(store2.init()).rejects.toThrow(/v0\.3\.0/)
  })
})
```

- [ ] **Step 2: Run test — should fail**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "Old format detection"`
Expected: FAIL — no detection logic yet.

- [ ] **Step 3: Add detection in `init()` after schema setup**

After `this._initSchema()` in `init()`, add:

```js
// Detect old v0.3.0 JSON embedding format
const sample = queryGet(this._db,
  "SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1"
)
if (sample?.embedding && typeof sample.embedding === 'string' && sample.embedding.startsWith('[')) {
  throw new Error(
    'AgentMemory v0.4.0 detected a v0.3.0 database with JSON embeddings. ' +
    'To upgrade: export your data with v0.3.0 (memory_export), upgrade to v0.4.0, ' +
    'then import (memory_import). See README for details.'
  )
}
```

- [ ] **Step 4: Run test**

Run: `cd packages/mcp-server && npx vitest run tests/persist.test.js -t "Old format detection"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/persist.test.js
git commit -m "feat: detect v0.3.0 JSON embeddings on startup and guide upgrade

Checks first non-null embedding on init(). If it's a JSON string (starts
with '['), throws with clear instructions to export/import."
```

---

## Chunk 6: Input Validation + Docs (Phases 6-7)

### Task 11: Add tag and metadata validation

**Files:**
- Modify: `packages/mcp-server/src/store.js` (extend `_validate` or add to `store()`/`update()`)
- Modify: `packages/mcp-server/tests/store.test.js`

- [ ] **Step 1: Write failing tests for tag validation**

Add to `tests/store.test.js` inside the `validation` describe block:

```js
it('rejects non-array tags', async () => {
  await expect(store.store('ns', 'k', 'content', 'not-an-array')).rejects.toThrow(/tags/)
})

it('rejects tags with non-string elements', async () => {
  await expect(store.store('ns', 'k', 'content', [123])).rejects.toThrow(/tags/)
})

it('rejects more than 50 tags', async () => {
  const tooMany = Array.from({ length: 51 }, (_, i) => `tag${i}`)
  await expect(store.store('ns', 'k', 'content', tooMany)).rejects.toThrow(/50/)
})

it('rejects tags longer than 100 characters', async () => {
  await expect(store.store('ns', 'k', 'content', ['a'.repeat(101)])).rejects.toThrow(/100/)
})
```

- [ ] **Step 2: Write failing tests for metadata validation**

```js
it('rejects non-object metadata', async () => {
  await expect(store.store('ns', 'k', 'content', [], 'not-an-object')).rejects.toThrow(/metadata/)
})

it('rejects array as metadata', async () => {
  await expect(store.store('ns', 'k', 'content', [], [1, 2, 3])).rejects.toThrow(/metadata/)
})

it('rejects null as metadata', async () => {
  await expect(store.store('ns', 'k', 'content', [], null)).rejects.toThrow(/metadata/)
})

it('rejects metadata over 10KB', async () => {
  const big = { data: 'x'.repeat(11000) }
  await expect(store.store('ns', 'k', 'content', [], big)).rejects.toThrow(/10KB/)
})
```

- [ ] **Step 3: Run tests — all should fail**

Run: `cd packages/mcp-server && npx vitest run tests/store.test.js -t "validation"`
Expected: New tests fail, existing ones pass.

- [ ] **Step 4: Add validation to `_validate()` in store.js**

After the existing content validation (line ~201), add:

```js
_validateTags(tags) {
  if (tags === undefined || tags === null) return
  if (!Array.isArray(tags)) {
    throw new Error('tags must be an array')
  }
  if (tags.length > 50) {
    throw new Error('tags must have 50 or fewer items')
  }
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new Error('each tag in tags must be a string')
    }
    if (tag.length > 100) {
      throw new Error('each tag must be 100 characters or less')
    }
  }
}

_validateMetadata(metadata) {
  if (metadata === undefined) return
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be a plain object')
  }
  const serialized = JSON.stringify(metadata)
  if (serialized.length > 10240) {
    throw new Error('metadata must be under 10KB when serialized')
  }
}
```

Call both at the top of `store()` and `update()`, after `this._validate(namespace, key, content)`:
```js
this._validateTags(tags)
this._validateMetadata(metadata)
```

- [ ] **Step 5: Run validation tests**

Run: `cd packages/mcp-server && npx vitest run tests/store.test.js -t "validation"`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/tests/store.test.js
git commit -m "feat: add tag and metadata input validation

Tags: must be array of strings, max 50 items, max 100 chars each.
Metadata: must be plain object, max 10KB serialized."
```

### Task 12: Update version, README, and add CHANGELOG

**Files:**
- Modify: `packages/mcp-server/package.json` (bump version to 0.4.0)
- Modify: `packages/mcp-server/src/index.js:27` (version string)
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `packages/mcp-server/benchmarks/search.js`

- [ ] **Step 1: Bump version in package.json**

Change `"version": "0.3.0"` to `"version": "0.4.0"` in `packages/mcp-server/package.json`.

- [ ] **Step 2: Bump version in index.js**

Change line 27:
```js
{ name: 'agentmemory', version: '0.3.0' },
```
to:
```js
{ name: 'agentmemory', version: '0.4.0' },
```

- [ ] **Step 3: Add DEBUG=agentmemory logging to source code**

In `store.js`, add at the top (after imports):
```js
const DEBUG = process.env.DEBUG?.includes('agentmemory')
function debug(...args) { if (DEBUG) console.error('[agentmemory]', ...args) }
```

Add `debug()` calls to:
- `persist()` — `debug('persist: writing', this._dbPath)`
- `init()` recovery paths — `debug('recovery: found .bak + .tmp, restoring .bak')` etc.
- `_markDirty()` — `debug('dirty: scheduling persist in 1s')`

In `embeddings.js`, add the same `debug` helper and log model load success/failure.

- [ ] **Step 4: Rewrite README.md**

Update to accurately reflect:
- sql.js (not better-sqlite3)
- Binary BLOB embeddings (not JSON text)
- TF-IDF fallback search
- v0.3.0 → v0.4.0 migration instructions (export → upgrade → import)
- Hardcoded limits: 20 max versions, 90-day usage log TTL, 100KB max content, 50 tags max
- `DEBUG=agentmemory` env var for verbose logging

- [ ] **Step 4: Create CHANGELOG.md**

```markdown
# Changelog

## [0.4.0] - 2026-03-13

### Breaking Changes
- Embeddings now stored as binary BLOBs instead of JSON text. Existing v0.3.0 databases are incompatible — export with v0.3.0, upgrade, then import.

### Fixed
- All 75 tests now pass (48 were broken due to missing `store.init()` in test setup)
- SQL string interpolation in usage log pruning replaced with parameterized query
- `close()` no longer throws on double-call
- `persist()` errors no longer propagate to callers
- Signal handlers wrapped in try/catch for safe shutdown

### Added
- Atomic writes: three-step rename with crash recovery
- Global `uncaughtException` and `unhandledRejection` handlers
- In-memory embedding cache (populated on first search, invalidated on writes)
- Input validation for tags (max 50, max 100 chars each) and metadata (max 10KB)
- Index on `memory_versions(memory_id, version)` for faster version lookups
- Old v0.3.0 database format detection with upgrade instructions

### Changed
- Persist is now debounced: write operations set a dirty flag, persist fires after 1 second of inactivity. Read operations never trigger persist.
- Embedding storage reduced ~33% via binary BLOBs instead of JSON text
```

- [ ] **Step 5: Create benchmark script**

Create `packages/mcp-server/benchmarks/search.js`:

```js
/**
 * Benchmark: search performance at scale
 * Usage: node benchmarks/search.js [count]
 * Default count: 1000
 */

import { MemoryStore } from '../src/store.js'

const count = parseInt(process.argv[2] || '1000', 10)
console.log(`Benchmarking search with ${count} memories...`)

const store = new MemoryStore(':memory:')
await store.init()

// Populate
const start = performance.now()
for (let i = 0; i < count; i++) {
  await store.store('bench', `key-${i}`, `Memory number ${i} about topic ${i % 10} with content for testing search performance`)
}
const populateMs = performance.now() - start
console.log(`Populated ${count} memories in ${(populateMs / 1000).toFixed(1)}s`)

// Search
const searchStart = performance.now()
const results = await store.search('bench', 'topic search performance testing', 10)
const searchMs = performance.now() - searchStart
console.log(`Search returned ${results.length} results in ${searchMs.toFixed(0)}ms`)

if (searchMs > 2000) {
  console.error(`FAIL: Search took ${searchMs.toFixed(0)}ms (target: < 2000ms)`)
  process.exit(1)
} else {
  console.log(`PASS: Search completed within target`)
}

store.close()
```

- [ ] **Step 6: Run full test suite one final time**

Run: `cd packages/mcp-server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/package.json packages/mcp-server/src/index.js README.md CHANGELOG.md packages/mcp-server/benchmarks/
git commit -m "docs: bump to v0.4.0, rewrite README, add CHANGELOG and benchmark

README now accurately reflects sql.js, binary embeddings, and TF-IDF fallback.
Includes v0.3.0 → v0.4.0 migration guide. Benchmark verifies search
performance target of < 2 seconds for 10K memories."
```
