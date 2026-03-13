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
| Vector search scaling | Binary BLOBs + in-memory cache | No native deps, avoids install friction, pragmatic for local tool. Chunked similarity deferred — not needed at target scale. |
| Backward compatibility | Clean break (v0.4.0) | Small user base, export/import tools exist, avoids migration debt |
| Persist strategy | Debounced write-on-mutation + safety interval | Eliminates persist-on-read waste, batches rapid writes |
| Tool surface area | Keep all 15 tools | Well-scoped, consolidation would add parameter complexity |
| Fix priority | Reliability first | Tests → atomic writes → error handling → persist → performance → docs |

## Phase 1: Fix Test Suite + Quick Cleanups

**Goal:** All 75 tests passing. Fix trivial code smells while we're here.

**Problem:** `store.test.js`, `search.test.js`, `advanced.test.js`, and `compression.test.js` create `new MemoryStore(':memory:')` in `beforeEach` but never call `await store.init()`. The database handle remains `null`, causing `TypeError: Cannot read properties of null (reading 'prepare')` in 48 tests.

**Fix:**
- Add `await store.init()` after `new MemoryStore(':memory:')` in all `beforeEach` hooks
- Fix SQL string interpolation on line 165 of `store.js`: replace `` `DELETE FROM usage_log WHERE created_at < datetime('now', '-${USAGE_LOG_TTL_DAYS} days')` `` with parameterized query using `[USAGE_LOG_TTL_DAYS]`
- Run full test suite, verify 75/75 pass

**Files (4 failing):** `tests/store.test.js`, `tests/search.test.js`, `tests/advanced.test.js`, `tests/compression.test.js`
**Files (2 already passing):** `tests/embeddings.test.js`, `tests/summarizer.test.js` — these test pure functions and don't instantiate `MemoryStore`, so they already pass. No changes needed.

## Phase 2: Atomic Writes + Schema Fixes

**Goal:** Eliminate database corruption risk from partial writes. Get all schema changes in for the clean break.

**Problem:** `writeFileSync(dbPath, buffer)` can leave a truncated/corrupted file if the process is killed mid-write. No recovery mechanism exists.

**Fix in `store.js`:**
- **Stale file cleanup:** At the top of `persist()`, delete any existing `.bak` file before starting. A prior crash may have left one behind, and Windows `renameSync` throws if the destination exists.
- Replace direct `writeFileSync` with a three-step Windows-safe swap:
  ```
  const tmpPath = this._dbPath + '.tmp';
  const bakPath = this._dbPath + '.bak';
  // 1. Write new data to temp file
  writeFileSync(tmpPath, Buffer.from(this._db.export()));
  // 2. If DB exists, move it to backup
  if (existsSync(this._dbPath)) renameSync(this._dbPath, bakPath);
  // 3. Move temp to DB path
  renameSync(tmpPath, this._dbPath);
  // 4. Clean up backup
  if (existsSync(bakPath)) unlinkSync(bakPath);
  ```
- **Recovery logic in `init()`:** On startup, check for `.tmp` and `.bak` files:
  - If `.bak` exists and `.tmp` exists: rename failed mid-swap → rename `.bak` back to DB path, delete `.tmp`
  - If `.bak` exists but no `.tmp`: swap completed but `.bak` wasn't cleaned up → delete `.bak`
  - If `.tmp` exists but no `.bak` and no DB: write completed but rename never started → rename `.tmp` to DB path
- **Schema addition:** Add `CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, version)` in `_initSchema()` — get all schema changes into the v0.4.0 clean break.

**Tests to add:**
- Test that persist creates a valid DB file
- Test that a `.tmp` file is cleaned up after successful persist
- Test that stale `.bak` is cleaned up before persist starts
- Test startup recovery when only `.tmp` exists

## Phase 3: Error Handling

**Goal:** Graceful degradation on disk errors, no silent process crashes.

**Problem 1:** No global error handlers. Unhandled errors crash the process with no cleanup.
**Fix:** Add to `index.js`:
```js
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || String(err));
  try { store.close(); } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason?.message || String(reason));
  try { store.close(); } catch (_) {}
  process.exit(1);
});
```
Note: `unhandledRejection` receives a rejection reason that may not be an `Error` object (could be a string, undefined, etc.). Always use optional chaining with a `String()` fallback.

**Constraint: `close()` must remain synchronous.** Process exit handlers (`uncaughtException`, `SIGINT`, `SIGTERM`) cannot reliably await async work. Since `persist()` uses `writeFileSync`, `close()` is currently sync and must stay that way.

**Problem 2:** `persist()` errors during operations cause inconsistent state — in-memory DB is modified but caller told operation failed.
**Fix:** Wrap `persist()` in try/catch. Log the error, set `this._persistFailed = true` for retry on the next safety interval tick, but don't propagate to caller. The in-memory operation succeeded; the disk write is a separate concern. The debounce timer (Phase 4) will have already fired, so `_persistFailed` is retried exclusively by the 5-second safety interval.

**Problem 3:** `close()` has no error handling and no double-close guard.
**Fix:** Wrap in try/catch, ensure `db.close()` runs even if `persist()` throws. Add double-close guard:
```js
close() {
  if (!this._db) return; // already closed
  try { this.persist(); } catch (err) { console.error('Persist failed on close:', err?.message || String(err)); }
  this._db.close();
  this._db = null;
}
```

**Problem 4:** Signal handlers in `index.js` (lines 700-701) have no error handling.
**Fix:** Wrap signal handlers in try/catch:
```js
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { store.close(); } catch (_) {}
    process.exit(0);
  });
}
```

**Tests to add:**
- Test that store operations succeed even when persist throws (mock `writeFileSync`)
- Test that `close()` completes even if persist fails
- Test that calling `close()` twice does not throw

## Phase 4: Debounced Persist

**Goal:** Eliminate unnecessary disk I/O, especially on read operations.

**Problem:** `persist()` (full DB serialization + disk write) runs after every operation including reads (`search`, `recall`, `list`). With a 10MB database, this means 10MB of I/O per search query.

**Fix:**
1. Remove `persist()` calls from all read operations: `search()`, `recall()`, `list()`, `stats()`, `summarize()`, `bulkRecall()`
2. Remove `persist()` calls from write operations. Replace with `this._markDirty()`
3. `_markDirty()` sets `this._dirty = true` and schedules a persist in 1000ms (debounced — resets timer on subsequent calls)
4. Modify the existing 5-second interval: only persist if `this._dirty === true` OR `this._persistFailed === true`, then clear both flags on success
5. `close()`: persist immediately if `this._dirty === true`

**Implementation:**
```js
_markDirty() {
  this._dirty = true;
  if (this._debounceTimer) clearTimeout(this._debounceTimer);
  this._debounceTimer = setTimeout(() => this.persist(), 1000);
}
```

**`close()` must clear the debounce timer** before persisting:
```js
close() {
  if (!this._db) return;
  if (this._debounceTimer) clearTimeout(this._debounceTimer);
  if (this._safetyInterval) clearInterval(this._safetyInterval);
  if (this._dirty) {
    try { this.persist(); } catch (err) { console.error('Persist failed on close:', err?.message || String(err)); }
  }
  this._db.close();
  this._db = null;
}
```
Without clearing the timer, a pending debounce could fire after `db.close()`, causing an error.

**Import behavior note:** `importMemories()` calls `store()` in a loop, which calls `_markDirty()` each time. The debounce timer resets on each call, so persist fires 1 second after the last imported memory. The 5-second safety interval provides a floor. This is acceptable behavior for import — no special handling needed here (batch mode in Phase 5b handles the cache concern separately).

**Tests to add:**
- Test that read operations do NOT trigger persist
- Test that write operations set dirty flag
- Test that close() persists if dirty
- Test debounce batching (multiple rapid writes → one persist)
- Test that close() does not error when a debounce timer is pending

## Phase 5: Binary Embeddings + Cached Search

**Goal:** Cut storage size ~33%, eliminate JSON parsing overhead on search.

**This is the breaking change that triggers v0.4.0.**

### 5a: Binary Embedding Storage

**Problem:** Embeddings stored as `JSON.stringify(vector)` (~2KB per 384-dim vector). `vectorToBuffer`/`bufferToVector` exist in `embeddings.js` (lines 74-84) and are imported in `store.js` (line 12) but never called.

**Fix:**
- Activate `vectorToBuffer()` in `_upsertEmbedding()` — store embeddings as binary BLOBs
- Activate `bufferToVector()` in `search()` — read embeddings as `Float32Array` (sql.js returns BLOBs as `Uint8Array`, which `bufferToVector` handles correctly)
- Remove JSON embedding code paths
- No migration logic — clean break, users export from v0.3.0 and import into v0.4.0 (import re-generates embeddings)

### 5b: In-Memory Embedding Cache

**Problem:** Every search query re-reads all embeddings from SQLite.

**Fix:**
- Add `this._embeddingCache = new Map()` keyed by namespace
- Each entry: `Map<memoryId, Float32Array>`
- Populated on first search per namespace (load all embeddings once)
- Invalidated on `store()`, `update()`, `forget()`, `deleteNamespace()` for the affected namespace
- Cache has no TTL — invalidation-based only (correct since we're single-process)
- **Import optimization:** `importMemories()` calls `store()` internally for each memory. To avoid cache thrash (invalidate + rebuild per imported memory), `importMemories()` should set a `_batchMode = true` flag that suppresses cache invalidation during import, then invalidate all affected namespaces once at the end.

### 5c: Old Format Detection

On startup in `init()`, after loading the database, sample the first memory with a non-null embedding. If the value is a string (starts with `[`), log an error with upgrade instructions and exit:
```
Error: AgentMemory v0.4.0 detected a v0.3.0 database with JSON embeddings.
To upgrade: export your data with v0.3.0 (memory_export), then import with v0.4.0 (memory_import).
```

**Tests to add:**
- Test binary embedding round-trip (store → search retrieves correct results)
- Test cache invalidation (store new memory → search reflects it)
- Test batch mode suppresses cache invalidation during import
- Test with empty namespace, single memory, 100+ memories

## Phase 6: Input Validation

**Goal:** Harden API inputs at system boundary.

### 6a: Tag Validation
- `tags` must be an array of strings
- Max 50 tags per memory
- Max 100 characters per tag
- Reject with clear error message on violation

### 6b: Metadata Validation
- `metadata` must be a plain object (not array, not null)
- Max 10KB when `JSON.stringify()`'d
- Reject with clear error message on violation
- No nesting depth limit — `JSON.stringify` already throws on circular references, and arbitrary depth has no real failure mode for TEXT column storage

**Tests to add:**
- Test tag validation (too many, too long, wrong type)
- Test metadata validation (too large, wrong type, array rejected, null rejected)

## Phase 7: README + Documentation

**Goal:** Documentation matches reality.

**Changes:**
- Rewrite README to reference sql.js (remove all better-sqlite3 / sqlite-vec mentions)
- Document search approach: semantic via Transformers.js embeddings with TF-IDF fallback
- Add v0.3.0 → v0.4.0 migration guide (export → upgrade → import)
- Document hardcoded limits: 20 max versions, 90-day usage log TTL, 100KB max content, 5-second safety interval
- Add CHANGELOG.md with v0.4.0 entry listing all changes
- Update package.json version to 0.4.0
- Add note: "Set `DEBUG=agentmemory` for verbose logging" and add `console.error` debug logging behind that env var in `persist()`, `init()` recovery paths, and embedding model load
- Add `benchmarks/search.js` script that creates N memories and times a search to verify the "10K in < 2 seconds" success criterion

## Out of Scope

- Auth / rate limiting (not needed for local MCP stdio tool)
- HTTP API layer (stays stdio-only)
- Database migration code (clean break instead)
- Tool consolidation (all 15 stay)
- Configurable limits via env vars (document hardcoded values, make configurable later if requested)
- Multi-process / clustering support
- Approximate nearest neighbor libraries (native dep avoidance)
- Chunked similarity processing (not needed at target scale of hundreds to low thousands of memories; add if users report memory issues)
- Pagination total counts (feature work, not a reliability fix — defer to v0.5.0)

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Test fix reveals other broken behavior | Phase 1 is isolated; review failures before proceeding |
| Atomic rename not atomic on network drives | Document: local filesystem only, no NFS/SMB |
| `renameSync` doesn't atomically overwrite on Windows/NTFS | Three-step swap (rename → rename → delete) with stale `.bak` cleanup and recovery logic in `init()` |
| Embedding cache grows unbounded | Single-process local tool; cache is bounded by total memories. Acceptable at target scale. |
| Users miss migration instructions | Bold warning in README, npm postinstall message, error on detecting old DB format in `init()` |
| `close()` called during pending debounce | Timer cleared before persist in `close()` |
| Embedding model fails to load | Current retry-on-each-call behavior is acceptable for v0.4.0. Backoff/permanent-fallback deferred to v0.5.0 |

## Success Criteria

1. All tests pass (75 existing + new tests for each phase)
2. No data loss on `kill -9` during write operations
3. Search benchmark (`benchmarks/search.js`) completes 10K-memory search in < 2 seconds
4. `persist()` never called on read-only operations
5. README accurately describes the implementation
6. `npm install` works on Windows, macOS, Linux without native build tools
