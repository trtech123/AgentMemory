# Design: sqlite-vec Migration, Tests, and Cleanup

**Date:** 2026-03-05
**Status:** Approved

## Context

AgentMemory v0.2 uses sql.js (SQLite compiled to WASM) for storage. Semantic search loads all embeddings into memory and computes cosine similarity in JS, which won't scale past a few hundred memories. There are no tests. The `packages/api/` directory is empty dead weight from an earlier redesign.

## Changes

### 1. Switch sql.js to better-sqlite3 + sqlite-vec

**Why:** sql.js is WASM-based SQLite. It can't load native extensions, requires writing the entire DB to disk on every mutation (`_persist()`), and is slower than native SQLite. better-sqlite3 is file-backed, supports extensions, and is the standard for Node.js SQLite.

**What changes in `store.js`:**
- Replace `sql.js` with `better-sqlite3` for the database layer
- Add `sqlite-vec` npm package for vector indexing
- Create a `vec0` virtual table for 384-dimensional float32 vectors (MiniLM-L6-v2 output)
- Replace the current search flow (load all rows → cosine similarity in JS → sort) with KNN queries against the `vec0` table
- Remove all `_persist()` calls — better-sqlite3 is file-backed, writes are immediate
- Remove the `search_index` TF-IDF table — sqlite-vec replaces it for semantic search
- Keep TF-IDF as a fallback path when the embedding model hasn't loaded yet

**Schema changes:**
```sql
-- New: vec0 virtual table for vector search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- Removed: search_index table (TF-IDF) — kept only as fallback
-- Removed: embedding BLOB column from memories table (moved to vec0)
```

**Search flow (embedding path):**
```
query text
  → embed(query)
  → KNN query against memory_embeddings vec0 table
  → JOIN with memories table for full content
  → filter by namespace + tags
  → return ranked results
```

**Migration on startup:**
- Detect if `memory_embeddings` virtual table exists
- If not, create it and backfill from existing `embedding` BLOB column in `memories`
- Drop the `embedding` column after migration (or leave it — SQLite doesn't support DROP COLUMN before 3.35)

**Dependencies:**
- Remove: `sql.js`
- Add: `better-sqlite3`, `sqlite-vec`

**Tradeoff:** Loses the zero-native-deps story. `better-sqlite3` requires a compile step (or prebuilt binary). Acceptable for the performance and scalability gains.

### 2. Add vitest test suite

**Location:** `packages/mcp-server/tests/`

**Test categories:**

| Category | What it covers |
|----------|---------------|
| Store CRUD | store, recall, update, forget — basic operations |
| Search | Semantic ranking via sqlite-vec, TF-IDF fallback, tag filtering, pagination, offset |
| Version history | Updates create versions, recall specific version by number |
| Import/export | Roundtrip (export then import), conflict modes (skip, overwrite) |
| Namespaces | List, delete with confirm gate, summarize |
| Validation | Missing/empty namespace, key too long, content too large |
| Edge cases | Corrupt DB recovery, store-then-update idempotency |
| Embeddings | vectorToBuffer/bufferToVector roundtrip, cosineSimilarity math |

**Setup:** Each test file gets a fresh `:memory:` better-sqlite3 database. No shared state between tests.

**Scripts:** `"test": "vitest run"`, `"test:watch": "vitest"` in `packages/mcp-server/package.json`.

**Dev dependency:** `vitest` added to mcp-server package.

### 3. Cleanup

- Delete empty `packages/api/` directory
- Keep monorepo structure (`packages/mcp-server/` stays)

## Out of scope

- Changing the embedding model (stays MiniLM-L6-v2)
- Changing the MCP tool API surface (all 12 tools stay the same)
- Publishing to npm
- Adding new features
