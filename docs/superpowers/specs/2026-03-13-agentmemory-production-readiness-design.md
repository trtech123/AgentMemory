# AgentMemory v0.4.0 — Production Readiness

**Date:** 2026-03-13
**Status:** Approved
**Breaking Change:** Yes (v0.3.0 → v0.4.0, requires export/import migration)

## Context

AgentMemory is a persistent memory MCP server for AI agents, distributed via npm. A production-readiness audit identified critical issues: 64% of tests broken, no atomic writes, brute-force vector search, full DB serialization on every operation (including reads), and stale documentation.

This spec defines the fixes needed to make AgentMemory reliable and performant for open-source adoption.

## Target Audience

Open-source npm package used by developers integrating memory into their MCP-compatible AI agents. Hundreds to low thousands of memories per user. Local-first (stdio transport, no HTTP).

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Vector search scaling | Binary BLOBs + in-memory cache + chunked similarity | No native deps, avoids install friction, pragmatic for local tool |
| Backward compatibility | Clean break (v0.4.0) | Small user base, export/import tools exist, avoids migration debt |
| Persist strategy | Debounced write-on-mutation + safety interval | Eliminates persist-on-read waste, batches rapid writes |
| Tool surface area | Keep all 15 tools | Well-scoped, consolidation would add parameter complexity |
| Fix priority | Reliability first | Tests → atomic writes → error handling → persist → performance → docs |

## Phase 1: Fix Test Suite

**Goal:** All 75 tests passing. This is the safety net for every subsequent change.

**Problem:** `store.test.js`, `search.test.js`, `advanced.test.js`, and `compression.test.js` create `new MemoryStore(':memory:')` in `beforeEach` but never call `await store.init()`. The database handle remains `null`, causing `TypeError: Cannot read properties of null (reading 'prepare')` in 48 tests.

**Fix:**
- Add `await store.init()` after `new MemoryStore(':memory:')` in all `beforeEach` hooks
- Run full test suite, verify 75/75 pass
- No other changes in this phase

**Files:** `tests/store.test.js`, `tests/search.test.js`, `tests/advanced.test.js`, `tests/compression.test.js`

## Phase 2: Atomic Writes

**Goal:** Eliminate database corruption risk from partial writes.

**Problem:** `writeFileSync(dbPath, buffer)` can leave a truncated/corrupted file if the process is killed mid-write. No recovery mechanism exists.

**Fix in `store.js`:**
- Replace direct `writeFileSync` with write-to-temp-then-rename:
  ```
  const tmpPath = this._dbPath + '.tmp';
  writeFileSync(tmpPath, Buffer.from(this._db.export()));
  renameSync(tmpPath, this._dbPath);
  ```
- `renameSync` is atomic on NTFS, ext4, and APFS
- Add startup recovery in `init()`: if `dbPath + '.tmp'` exists but `dbPath` does not, rename `.tmp` → `dbPath` before loading

**Tests to add:**
- Test that persist creates a valid DB file
- Test that a `.tmp` file is cleaned up after successful persist
- Test startup recovery when only `.tmp` exists

## Phase 3: Error Handling

**Goal:** Graceful degradation on disk errors, no silent process crashes.

**Problem 1:** No global error handlers. Unhandled errors crash the process with no cleanup.
**Fix:** Add to `index.js`:
```js
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err.message);
  await store.close();
  process.exit(1);
});
process.on('unhandledRejection', async (err) => {
  console.error('Unhandled rejection:', err.message);
  await store.close();
  process.exit(1);
});
```

**Problem 2:** `persist()` errors during operations cause inconsistent state — in-memory DB is modified but caller told operation failed.
**Fix:** Wrap `persist()` in try/catch. Log the error, set `this._persistFailed = true` for retry on next interval, but don't propagate to caller. The in-memory operation succeeded; the disk write is a separate concern.

**Problem 3:** `close()` has no error handling.
**Fix:** Wrap in try/catch, ensure `db.close()` runs even if `persist()` throws.

**Tests to add:**
- Test that store operations succeed even when persist throws (mock `writeFileSync`)
- Test that `close()` completes even if persist fails

## Phase 4: Debounced Persist

**Goal:** Eliminate unnecessary disk I/O, especially on read operations.

**Problem:** `persist()` (full DB serialization + disk write) runs after every operation including reads (`search`, `recall`, `list`). With a 10MB database, this means 10MB of I/O per search query.

**Fix:**
1. Remove `persist()` calls from all read operations: `search()`, `recall()`, `list()`, `stats()`, `summarize()`, `bulkRecall()`
2. Remove `persist()` calls from write operations. Replace with `this._markDirty()`
3. `_markDirty()` sets `this._dirty = true` and schedules a persist in 1000ms (debounced — resets timer on subsequent calls)
4. Modify the existing 5-second interval: only persist if `this._dirty === true`, then clear the flag
5. `close()`: persist immediately if `this._dirty === true`

**Implementation:**
```js
_markDirty() {
  this._dirty = true;
  if (this._debounceTimer) clearTimeout(this._debounceTimer);
  this._debounceTimer = setTimeout(() => this.persist(), 1000);
}
```

**Tests to add:**
- Test that read operations do NOT trigger persist
- Test that write operations set dirty flag
- Test that close() persists if dirty
- Test debounce batching (multiple rapid writes → one persist)

## Phase 5: Binary Embeddings + Cached Search

**Goal:** Cut storage size ~33%, eliminate JSON parsing overhead on search, scale to ~50K memories.

**This is the breaking change that triggers v0.4.0.**

### 5a: Binary Embedding Storage

**Problem:** Embeddings stored as `JSON.stringify(vector)` (~2KB per 384-dim vector). `vectorToBuffer`/`bufferToVector` exist in `store.js` but are dead code.

**Fix:**
- Activate `vectorToBuffer()` in `store()` and `update()` — store embeddings as binary BLOBs
- Activate `bufferToVector()` in `search()` — read embeddings as `Float32Array`
- Remove JSON embedding code paths
- No migration logic — clean break, users export from v0.3.0 and import into v0.4.0 (import re-generates embeddings)

### 5b: In-Memory Embedding Cache

**Problem:** Every search query re-reads and re-parses all embeddings from SQLite.

**Fix:**
- Add `this._embeddingCache = new Map()` keyed by namespace
- Each entry: `Map<memoryId, Float32Array>`
- Populated on first search per namespace (load all embeddings once)
- Invalidated on `store()`, `update()`, `forget()`, `deleteNamespace()` for the affected namespace
- Cache has no TTL — invalidation-based only (correct since we're single-process)

### 5c: Chunked Similarity

**Problem:** All embeddings loaded into a single array, sorted, sliced. Memory spike for large namespaces.

**Fix:**
- Process similarity in chunks of 1000 embeddings
- Maintain a top-K min-heap (where K = requested limit, default 10) across chunks
- This bounds memory usage to `chunk_size * embedding_dim * 4 bytes` = ~1.5MB per chunk regardless of namespace size

**Tests to add:**
- Test binary embedding round-trip (store → search retrieves correct results)
- Test cache invalidation (store new memory → search reflects it)
- Test chunked search produces same results as full search
- Test with empty namespace, single memory, 100+ memories

## Phase 6: Input Validation + Minor Fixes

**Goal:** Harden API inputs, fix minor issues found in audit.

### 6a: Tag Validation
- `tags` must be an array of strings
- Max 50 tags per memory
- Max 100 characters per tag
- Reject with clear error message on violation

### 6b: Metadata Validation
- `metadata` must be a plain object (not array, not null)
- Max 10KB when `JSON.stringify()`'d
- Max nesting depth of 3 levels
- Reject with clear error message on violation

### 6c: Missing Index
- Add `CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, version)`
- Add in `_initSchema()`

### 6d: Pagination Total Count
- `search()` and `list()` return `{ memories: [...], total: N }` instead of just the array
- Requires a `COUNT(*)` query alongside the data query
- Backward-compatible addition (new field, existing fields unchanged)

### 6e: SQL Interpolation Fix
- Replace `` `DELETE FROM usage_log WHERE created_at < datetime('now', '-${USAGE_LOG_TTL_DAYS} days')` ``
- With parameterized: `DELETE FROM usage_log WHERE created_at < datetime('now', '-' || ? || ' days')` using `[USAGE_LOG_TTL_DAYS]`

**Tests to add:**
- Test tag validation (too many, too long, wrong type)
- Test metadata validation (too large, too deep, wrong type)
- Test pagination total count accuracy
- Test version index improves query plan (optional)

## Phase 7: README + Documentation

**Goal:** Documentation matches reality.

**Changes:**
- Rewrite README to reference sql.js (remove all better-sqlite3 / sqlite-vec mentions)
- Document search approach: semantic via Transformers.js embeddings with TF-IDF fallback
- Add v0.3.0 → v0.4.0 migration guide (export → upgrade → import)
- Document hardcoded limits: 20 max versions, 90-day usage log TTL, 100KB max content, 5-second safety interval
- Add CHANGELOG.md with v0.4.0 entry listing all changes
- Update package.json version to 0.4.0

## Out of Scope

- Auth / rate limiting (not needed for local MCP stdio tool)
- HTTP API layer (stays stdio-only)
- Database migration code (clean break instead)
- Tool consolidation (all 15 stay)
- Configurable limits via env vars (document hardcoded values, make configurable later if requested)
- Multi-process / clustering support
- Approximate nearest neighbor libraries (native dep avoidance)

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Test fix reveals other broken behavior | Phase 1 is isolated; review failures before proceeding |
| Atomic rename not atomic on network drives | Document: local filesystem only, no NFS/SMB |
| Embedding cache grows unbounded | Single-process local tool; cache is bounded by total memories. Add cache size monitoring in Phase 6 if needed |
| Chunked search returns different ordering than brute-force for tied scores | Accept: tie-breaking order is implementation detail, not a contract |
| Users miss migration instructions | Bold warning in README, npm postinstall message, error on detecting old DB format |

## Success Criteria

1. All tests pass (75 existing + new tests for each phase)
2. No data loss on `kill -9` during write operations
3. Search over 10K memories completes in < 2 seconds
4. `persist()` never called on read-only operations
5. README accurately describes the implementation
6. `npm install` works on Windows, macOS, Linux without native build tools
