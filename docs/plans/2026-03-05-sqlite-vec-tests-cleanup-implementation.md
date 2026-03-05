# sqlite-vec Migration, Tests, and Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace sql.js with better-sqlite3 + sqlite-vec for scalable vector search, add vitest test suite, delete empty packages/api/.

**Architecture:** MemoryStore switches from async WASM SQLite (sql.js) to synchronous native SQLite (better-sqlite3) with the sqlite-vec extension for KNN vector search. The constructor becomes synchronous. All public methods stay async (embedding is async). Tests use :memory: databases for isolation.

**Tech Stack:** better-sqlite3, sqlite-vec (v0.1.7-alpha.2), vitest, @huggingface/transformers (unchanged)

**Reference:** `docs/plans/2026-03-05-sqlite-vec-tests-cleanup-design.md`

---

### Task 1: Delete packages/api and swap dependencies

**Files:**
- Delete: `packages/api/` (empty directory)
- Modify: `packages/mcp-server/package.json`

**Step 1: Delete empty packages/api/**

Run: `rm -rf packages/api`

**Step 2: Update package.json dependencies**

In `packages/mcp-server/package.json`, replace `sql.js` with `better-sqlite3` and `sqlite-vec`, add vitest:

```json
{
  "name": "@agentmemory/mcp-server",
  "version": "0.3.0",
  "description": "MCP server for AgentMemory — persistent memory for AI agents",
  "type": "module",
  "main": "src/index.js",
  "bin": {
    "agentmemory-mcp": "src/index.js"
  },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.8.1",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^12.6.0",
    "sqlite-vec": "^0.1.7-alpha.2"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  },
  "keywords": ["mcp", "agent", "memory", "ai", "llm", "context"],
  "license": "MIT"
}
```

**Step 3: Install dependencies**

Run: `cd packages/mcp-server && rm -rf node_modules package-lock.json && npm install`

Verify sqlite-vec loads:
Run: `cd packages/mcp-server && node -e "import Database from 'better-sqlite3'; import * as sqliteVec from 'sqlite-vec'; const db = new Database(':memory:'); sqliteVec.load(db); const v = db.prepare('select vec_version()').get(); console.log('sqlite-vec', v)"`

Expected: prints sqlite-vec version without errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: swap sql.js for better-sqlite3 + sqlite-vec, add vitest, delete packages/api"
```

---

### Task 2: Rewrite store.js for better-sqlite3 + sqlite-vec

**Files:**
- Rewrite: `packages/mcp-server/src/store.js`

This is a full rewrite. The public API stays identical. Key changes:
- `sql.js` → `better-sqlite3` (synchronous)
- `_persist()` removed (file-backed DB, writes are immediate)
- `_ready` / `_ensureReady()` removed (constructor is synchronous, only embedding is async)
- In-memory cosine similarity → vec0 KNN queries
- `embedding BLOB` column on memories table → separate `memory_embeddings` vec0 virtual table
- `search_index` TF-IDF table kept as fallback

**Step 1: Write the new store.js**

```js
/**
 * AgentMemory Store
 *
 * Local storage engine using better-sqlite3 with sqlite-vec
 * for KNN vector search and TF-IDF fallback.
 */

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { embed, isReady as embeddingsReady, vectorToBuffer } from './embeddings.js'

const DEFAULT_DB_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.agentmemory')

export class MemoryStore {
  constructor(dbPath) {
    if (dbPath === ':memory:') {
      this._db = new Database(':memory:')
    } else {
      this._dir = dbPath || DEFAULT_DB_DIR
      this._dbPath = join(this._dir, 'memories.db')
      if (!existsSync(this._dir)) mkdirSync(this._dir, { recursive: true })
      this._db = new Database(this._dbPath)
    }

    this._db.pragma('journal_mode = WAL')
    sqliteVec.load(this._db)
    this._initSchema()
  }

  _initSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, key)
      )
    `)
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)`)
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(namespace, key)`)
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)`)

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS memory_versions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        metadata TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      )
    `)

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS search_index (
        memory_id TEXT NOT NULL,
        term TEXT NOT NULL,
        tf REAL NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      )
    `)
    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_search_term ON search_index(term)`)

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
        id text primary key,
        embedding float[384]
      )
    `)

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        namespace TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    this._migrate()
  }

  _migrate() {
    // Migrate from old sql.js schema: if memories has embedding BLOB column,
    // backfill into vec0 table, then we leave the column (SQLite can't drop columns < 3.35)
    const hasEmbeddingCol = this._db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('memories') WHERE name = 'embedding'"
    ).get()

    if (hasEmbeddingCol.cnt > 0) {
      const rows = this._db.prepare(
        'SELECT id, embedding FROM memories WHERE embedding IS NOT NULL'
      ).all()

      const insertVec = this._db.prepare(
        'INSERT OR IGNORE INTO memory_embeddings(id, embedding) VALUES (?, ?)'
      )
      for (const row of rows) {
        if (row.embedding) {
          insertVec.run(row.id, row.embedding)
        }
      }
    }

    // Backfill usage_log for existing memories
    const hasLogs = this._db.prepare('SELECT COUNT(*) as count FROM usage_log').get()
    if (hasLogs.count === 0) {
      const allMemories = this._db.prepare('SELECT namespace, content FROM memories').all()
      const insertLog = this._db.prepare(
        'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)'
      )
      for (const m of allMemories) {
        insertLog.run('store', m.namespace, Math.ceil(m.content.length / 4), new Date().toISOString())
      }
    }
  }

  _generateId() {
    return randomUUID().replace(/-/g, '').substring(0, 16)
  }

  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  }

  _validate(namespace, key, content) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new Error('key is required and must be a non-empty string')
    }
    if (namespace.length > 255) throw new Error('namespace must be 255 characters or less')
    if (key.length > 255) throw new Error('key must be 255 characters or less')
    if (content !== undefined && content !== null) {
      if (typeof content !== 'string') throw new Error('content must be a string')
      if (content.length > 100000) throw new Error('content must be 100,000 characters or less')
    }
  }

  _escapeTagFilter(tag) {
    return `%${JSON.stringify(tag)}%`
  }

  _indexMemory(memoryId, content) {
    this._db.prepare('DELETE FROM search_index WHERE memory_id = ?').run(memoryId)
    const tokens = this._tokenize(content)
    if (tokens.length === 0) return

    const freq = {}
    for (const token of tokens) {
      freq[token] = (freq[token] || 0) + 1
    }

    const insert = this._db.prepare(
      'INSERT INTO search_index (memory_id, term, tf) VALUES (?, ?, ?)'
    )
    for (const [term, count] of Object.entries(freq)) {
      insert.run(memoryId, term, count / tokens.length)
    }
  }

  _upsertEmbedding(memoryId, vector) {
    if (!vector) return
    const buf = vectorToBuffer(vector)
    // Delete old embedding if exists, then insert new one
    this._db.prepare('DELETE FROM memory_embeddings WHERE id = ?').run(memoryId)
    this._db.prepare('INSERT INTO memory_embeddings(id, embedding) VALUES (?, ?)').run(memoryId, buf)
  }

  _formatRow(row) {
    return {
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      content: row.content,
      tags: JSON.parse(row.tags || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(row.score !== undefined ? { score: row.score } : {}),
    }
  }

  _estimateTokens(text) {
    return Math.ceil(text.length / 4)
  }

  _logUsage(operation, namespace, tokensUsed = 0) {
    this._db.prepare(
      'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)'
    ).run(operation, namespace || null, tokensUsed, new Date().toISOString())
  }

  async store(namespace, key, content, tags = [], metadata = {}) {
    this._validate(namespace, key, content)

    const existing = this._db.prepare(
      'SELECT id, version FROM memories WHERE namespace = ? AND key = ?'
    ).get(namespace, key)

    if (existing) {
      return this.update(namespace, key, content, tags, metadata)
    }

    const now = new Date().toISOString()
    const id = this._generateId()

    this._db.prepare(
      `INSERT INTO memories (id, namespace, key, content, tags, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, namespace, key, content, JSON.stringify(tags), JSON.stringify(metadata), now, now)

    const vector = await embed(`${key} ${content}`)
    this._upsertEmbedding(id, vector)

    this._db.prepare(
      `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(this._generateId(), id, content, JSON.stringify(tags), JSON.stringify(metadata), now)

    this._indexMemory(id, `${key} ${content} ${tags.join(' ')}`)

    const tokens = this._estimateTokens(content)
    this._logUsage('store', namespace, tokens)

    return { id, namespace, key, version: 1, created_at: now, tokens }
  }

  async search(namespace, query, limit = 10, tags = [], offset = 0) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new Error('query is required and must be a non-empty string')
    }

    // Try embedding-based KNN search via sqlite-vec
    if (embeddingsReady()) {
      const queryVec = await embed(query)
      if (queryVec) {
        const queryBuf = vectorToBuffer(queryVec)

        // Over-fetch from vec0 to account for namespace/tag filtering
        const overFetchLimit = Math.max(limit * 5, 50)
        const candidates = this._db.prepare(
          `SELECT id, distance FROM memory_embeddings WHERE embedding MATCH ? AND k = ?`
        ).all(queryBuf, overFetchLimit)

        if (candidates.length > 0) {
          const candidateIds = candidates.map(c => c.id)
          const distanceMap = new Map(candidates.map(c => [c.id, c.distance]))

          const placeholders = candidateIds.map(() => '?').join(',')
          let sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND namespace = ?`
          const params = [...candidateIds, namespace]

          for (const tag of tags) {
            sql += ' AND tags LIKE ?'
            params.push(this._escapeTagFilter(tag))
          }

          const rows = this._db.prepare(sql).all(...params)
          const results = rows.map(row => ({
            ...this._formatRow(row),
            score: 1 / (1 + distanceMap.get(row.id)),
          }))

          results.sort((a, b) => b.score - a.score)
          const paged = results.slice(offset, offset + limit)

          const tokensSaved = paged.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
          this._logUsage('search', namespace, tokensSaved)
          return paged
        }
      }
    }

    // Fallback: TF-IDF term matching
    const queryTokens = this._tokenize(query)
    if (queryTokens.length === 0) {
      let sql = 'SELECT * FROM memories WHERE namespace = ?'
      const params = [namespace]
      for (const tag of tags) {
        sql += ' AND tags LIKE ?'
        params.push(this._escapeTagFilter(tag))
      }
      sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      params.push(limit, offset)
      return this._db.prepare(sql).all(...params).map(row => this._formatRow(row))
    }

    const termPlaceholders = queryTokens.map(() => '?').join(',')
    const sql = `
      SELECT m.*, SUM(si.tf) as score
      FROM search_index si
      JOIN memories m ON m.id = si.memory_id
      WHERE si.term IN (${termPlaceholders})
      AND m.namespace = ?
      ${tags.map(() => ' AND m.tags LIKE ?').join('')}
      GROUP BY m.id ORDER BY score DESC LIMIT ? OFFSET ?
    `
    const params = [...queryTokens, namespace, ...tags.map(t => this._escapeTagFilter(t)), limit, offset]
    const rows = this._db.prepare(sql).all(...params)
    const results = rows.map(row => this._formatRow(row))

    const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
    this._logUsage('search', namespace, tokensSaved)
    return results
  }

  async recall(namespace, key, version) {
    this._validate(namespace, key)

    if (version) {
      const memory = this._db.prepare(
        'SELECT * FROM memories WHERE namespace = ? AND key = ?'
      ).get(namespace, key)
      if (!memory) return null

      const versionRow = this._db.prepare(
        'SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?'
      ).get(memory.id, version)

      if (versionRow) {
        const result = this._formatRow(memory)
        result.content = versionRow.content
        result.version = versionRow.version
        if (versionRow.tags) result.tags = JSON.parse(versionRow.tags)
        if (versionRow.metadata) result.metadata = JSON.parse(versionRow.metadata)
        this._logUsage('recall', namespace, this._estimateTokens(result.content))
        return result
      }
    }

    const row = this._db.prepare(
      'SELECT * FROM memories WHERE namespace = ? AND key = ?'
    ).get(namespace, key)
    if (!row) return null

    const result = this._formatRow(row)
    this._logUsage('recall', namespace, this._estimateTokens(result.content))
    return result
  }

  async update(namespace, key, content, tags, metadata) {
    this._validate(namespace, key, content)

    const existing = this._db.prepare(
      'SELECT * FROM memories WHERE namespace = ? AND key = ?'
    ).get(namespace, key)

    if (!existing) {
      return this.store(namespace, key, content, tags, metadata)
    }

    const now = new Date().toISOString()
    const newVersion = existing.version + 1
    const newTags = tags !== undefined ? JSON.stringify(tags) : existing.tags
    const newMeta = metadata !== undefined
      ? JSON.stringify({ ...JSON.parse(existing.metadata), ...metadata })
      : existing.metadata

    this._db.prepare(
      `UPDATE memories SET content = ?, tags = ?, metadata = ?, version = ?, updated_at = ?
       WHERE id = ?`
    ).run(content, newTags, newMeta, newVersion, now, existing.id)

    const vector = await embed(`${key} ${content}`)
    this._upsertEmbedding(existing.id, vector)

    this._db.prepare(
      `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(this._generateId(), existing.id, content, newTags, newMeta, newVersion, now)

    this._indexMemory(existing.id, `${key} ${content} ${(tags || []).join(' ')}`)

    const tokens = this._estimateTokens(content)
    this._logUsage('update', namespace, tokens)

    return { id: existing.id, namespace, key, version: newVersion, updated_at: now, tokens }
  }

  async forget(namespace, key) {
    this._validate(namespace, key)

    const existing = this._db.prepare(
      'SELECT id FROM memories WHERE namespace = ? AND key = ?'
    ).get(namespace, key)

    if (!existing) return false

    this._db.prepare('DELETE FROM memory_embeddings WHERE id = ?').run(existing.id)
    this._db.prepare('DELETE FROM search_index WHERE memory_id = ?').run(existing.id)
    this._db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(existing.id)
    this._db.prepare('DELETE FROM memories WHERE id = ?').run(existing.id)
    return true
  }

  async list(namespace, prefix, tags = [], limit = 50, offset = 0) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }

    let sql = 'SELECT * FROM memories WHERE namespace = ?'
    const params = [namespace]

    if (prefix) {
      sql += ' AND key LIKE ?'
      params.push(`${prefix}%`)
    }

    for (const tag of (tags || [])) {
      sql += ' AND tags LIKE ?'
      params.push(this._escapeTagFilter(tag))
    }

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)

    return this._db.prepare(sql).all(...params).map(row => this._formatRow(row))
  }

  async listNamespaces() {
    return this._db.prepare(
      'SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY namespace'
    ).all()
  }

  async getStats() {
    const tokensStored = this._db.prepare(
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('store', 'update')"
    ).get()
    const tokensSaved = this._db.prepare(
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('search', 'recall')"
    ).get()
    const memoryCount = this._db.prepare('SELECT COUNT(*) as count FROM memories').get()
    const namespaceCount = this._db.prepare('SELECT COUNT(DISTINCT namespace) as count FROM memories').get()

    return {
      total_tokens_stored: tokensStored?.total || 0,
      total_tokens_saved: tokensSaved?.total || 0,
      total_memories: memoryCount?.count || 0,
      total_namespaces: namespaceCount?.count || 0,
    }
  }

  async deleteNamespace(namespace, confirm = false) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }

    if (!confirm) {
      const count = this._db.prepare(
        'SELECT COUNT(*) as count FROM memories WHERE namespace = ?'
      ).get(namespace)
      return { confirmed: false, count: count?.count || 0 }
    }

    const memories = this._db.prepare(
      'SELECT id FROM memories WHERE namespace = ?'
    ).all(namespace)

    for (const m of memories) {
      this._db.prepare('DELETE FROM memory_embeddings WHERE id = ?').run(m.id)
      this._db.prepare('DELETE FROM search_index WHERE memory_id = ?').run(m.id)
      this._db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(m.id)
    }
    this._db.prepare('DELETE FROM memories WHERE namespace = ?').run(namespace)
    this._db.prepare('DELETE FROM usage_log WHERE namespace = ?').run(namespace)

    return { confirmed: true, deleted: memories.length }
  }

  async exportNamespace(namespace) {
    let sql = 'SELECT * FROM memories'
    const params = []

    if (namespace) {
      sql += ' WHERE namespace = ?'
      params.push(namespace)
    }

    sql += ' ORDER BY namespace, key'
    const memories = this._db.prepare(sql).all(...params)

    const exported = memories.map(row => {
      const formatted = this._formatRow(row)

      const versions = this._db.prepare(
        'SELECT content, tags, metadata, version, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version'
      ).all(row.id)
      formatted.versions = versions.map(v => ({
        content: v.content,
        tags: v.tags ? JSON.parse(v.tags) : null,
        metadata: v.metadata ? JSON.parse(v.metadata) : null,
        version: v.version,
        created_at: v.created_at,
      }))

      delete formatted.id
      delete formatted.score
      return formatted
    })

    return {
      export_version: 1,
      exported_at: new Date().toISOString(),
      namespace: namespace || 'all',
      count: exported.length,
      memories: exported,
    }
  }

  async importMemories(data, onConflict = 'skip') {
    if (data.export_version !== 1) {
      throw new Error(`Unsupported export version: ${data.export_version}`)
    }

    let imported = 0
    let skipped = 0
    let overwritten = 0

    for (const memory of data.memories) {
      const existing = this._db.prepare(
        'SELECT id FROM memories WHERE namespace = ? AND key = ?'
      ).get(memory.namespace, memory.key)

      if (existing) {
        if (onConflict === 'skip') {
          skipped++
          continue
        }
        await this.forget(memory.namespace, memory.key)
        overwritten++
      }

      await this.store(
        memory.namespace,
        memory.key,
        memory.content,
        memory.tags || [],
        memory.metadata || {}
      )
      imported++
    }

    return { imported, skipped, overwritten }
  }

  async summarize(namespace) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }

    const total = this._db.prepare(
      'SELECT COUNT(*) as count FROM memories WHERE namespace = ?'
    ).get(namespace)

    if (!total || total.count === 0) return null

    const memories = this._db.prepare(
      'SELECT key, tags, version, updated_at, LENGTH(content) as content_length FROM memories WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace)

    const byTag = {}
    const untagged = []
    for (const m of memories) {
      const tags = JSON.parse(m.tags || '[]')
      if (tags.length === 0) {
        untagged.push(m.key)
      } else {
        for (const tag of tags) {
          if (!byTag[tag]) byTag[tag] = []
          byTag[tag].push(m.key)
        }
      }
    }

    const recent = memories.slice(0, 5)

    const tokenTotal = this._db.prepare(
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('store', 'update') AND namespace = ?"
    ).get(namespace)

    return {
      namespace,
      total_memories: total.count,
      total_tokens: tokenTotal?.total || 0,
      by_tag: byTag,
      untagged,
      recent_updates: recent.map(m => ({
        key: m.key,
        version: m.version,
        updated_at: m.updated_at,
        content_length: m.content_length,
      })),
    }
  }

  close() {
    if (this._db) {
      this._db.close()
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `cd packages/mcp-server && node -e "import('./src/store.js').then(() => console.log('OK')).catch(e => console.error(e.message))"`

Expected: "OK" (or embedding model warning, which is fine)

**Step 3: Commit**

```bash
git add packages/mcp-server/src/store.js
git commit -m "feat: rewrite store for better-sqlite3 + sqlite-vec KNN search"
```

---

### Task 3: Update index.js

**Files:**
- Modify: `packages/mcp-server/src/index.js`

The only changes: remove the `_persist` concept from close(), bump version. The index.js MCP handlers don't change since the store's public API is identical.

**Step 1: Update version string and simplify shutdown**

In `packages/mcp-server/src/index.js`:
- Line 26: change `version: '0.2.0'` to `version: '0.3.0'`

No other changes needed — the store API is unchanged and close() already works.

**Step 2: Commit**

```bash
git add packages/mcp-server/src/index.js
git commit -m "chore: bump server version to 0.3.0"
```

---

### Task 4: Add vitest config and embedding utility tests

**Files:**
- Create: `packages/mcp-server/vitest.config.js`
- Create: `packages/mcp-server/tests/embeddings.test.js`

**Step 1: Create vitest config**

```js
// packages/mcp-server/vitest.config.js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 30000,
  },
})
```

**Step 2: Write embedding utility tests**

These test the pure functions (no model needed):

```js
// packages/mcp-server/tests/embeddings.test.js
import { describe, it, expect } from 'vitest'
import { cosineSimilarity, vectorToBuffer, bufferToVector } from '../src/embeddings.js'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = [1, 0, 0]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0)
  })

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0]
    const b = [-1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0)
  })

  it('returns 0 for zero vectors', () => {
    const a = [0, 0, 0]
    const b = [1, 2, 3]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('computes correct similarity for arbitrary vectors', () => {
    const a = [1, 2, 3]
    const b = [4, 5, 6]
    // dot=32, |a|=sqrt(14), |b|=sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77))
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected)
  })
})

describe('vectorToBuffer / bufferToVector roundtrip', () => {
  it('roundtrips a simple vector', () => {
    const original = [0.1, 0.2, 0.3, -0.5]
    const buf = vectorToBuffer(original)
    const recovered = bufferToVector(buf)
    expect(recovered.length).toBe(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5)
    }
  })

  it('roundtrips a 384-dim vector', () => {
    const original = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1))
    const buf = vectorToBuffer(original)
    expect(buf.byteLength).toBe(384 * 4) // float32 = 4 bytes
    const recovered = bufferToVector(buf)
    expect(recovered.length).toBe(384)
    for (let i = 0; i < 384; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5)
    }
  })
})
```

**Step 3: Run tests**

Run: `cd packages/mcp-server && npx vitest run tests/embeddings.test.js`

Expected: All pass.

**Step 4: Commit**

```bash
git add packages/mcp-server/vitest.config.js packages/mcp-server/tests/
git commit -m "test: add vitest config and embedding utility tests"
```

---

### Task 5: Write store CRUD tests

**Files:**
- Create: `packages/mcp-server/tests/store.test.js`

Tests mock the embeddings module to avoid loading the 23MB model. The mock produces deterministic vectors based on text content so vector search still works.

**Step 1: Write store tests**

```js
// packages/mcp-server/tests/store.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock embeddings to avoid loading the real model
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

  beforeEach(() => {
    store = new MemoryStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  describe('store()', () => {
    it('stores a memory and returns metadata', async () => {
      const result = await store.store('ns', 'key1', 'hello world')
      expect(result.namespace).toBe('ns')
      expect(result.key).toBe('key1')
      expect(result.version).toBe(1)
      expect(result.tokens).toBeGreaterThan(0)
    })

    it('stores with tags and metadata', async () => {
      await store.store('ns', 'key1', 'content', ['tag1', 'tag2'], { priority: 'high' })
      const recalled = await store.recall('ns', 'key1')
      expect(recalled.tags).toEqual(['tag1', 'tag2'])
      expect(recalled.metadata).toEqual({ priority: 'high' })
    })

    it('upserts on duplicate key', async () => {
      await store.store('ns', 'key1', 'version 1')
      const result = await store.store('ns', 'key1', 'version 2')
      expect(result.version).toBe(2)
      const recalled = await store.recall('ns', 'key1')
      expect(recalled.content).toBe('version 2')
    })
  })

  describe('recall()', () => {
    it('returns null for nonexistent key', async () => {
      const result = await store.recall('ns', 'nope')
      expect(result).toBeNull()
    })

    it('returns the stored memory', async () => {
      await store.store('ns', 'key1', 'hello')
      const result = await store.recall('ns', 'key1')
      expect(result.content).toBe('hello')
      expect(result.namespace).toBe('ns')
      expect(result.key).toBe('key1')
    })

    it('recalls a specific version', async () => {
      await store.store('ns', 'key1', 'v1 content')
      await store.update('ns', 'key1', 'v2 content')
      const v1 = await store.recall('ns', 'key1', 1)
      expect(v1.content).toBe('v1 content')
      expect(v1.version).toBe(1)
      const latest = await store.recall('ns', 'key1')
      expect(latest.content).toBe('v2 content')
      expect(latest.version).toBe(2)
    })
  })

  describe('update()', () => {
    it('creates if not exists', async () => {
      const result = await store.update('ns', 'key1', 'content')
      expect(result.version).toBe(1)
    })

    it('increments version', async () => {
      await store.store('ns', 'key1', 'v1')
      const result = await store.update('ns', 'key1', 'v2')
      expect(result.version).toBe(2)
    })

    it('merges metadata', async () => {
      await store.store('ns', 'key1', 'content', [], { a: 1 })
      await store.update('ns', 'key1', 'content v2', undefined, { b: 2 })
      const recalled = await store.recall('ns', 'key1')
      expect(recalled.metadata).toEqual({ a: 1, b: 2 })
    })

    it('replaces tags when provided', async () => {
      await store.store('ns', 'key1', 'content', ['old'])
      await store.update('ns', 'key1', 'content v2', ['new'])
      const recalled = await store.recall('ns', 'key1')
      expect(recalled.tags).toEqual(['new'])
    })
  })

  describe('forget()', () => {
    it('returns false for nonexistent key', async () => {
      const result = await store.forget('ns', 'nope')
      expect(result).toBe(false)
    })

    it('deletes the memory', async () => {
      await store.store('ns', 'key1', 'content')
      const result = await store.forget('ns', 'key1')
      expect(result).toBe(true)
      expect(await store.recall('ns', 'key1')).toBeNull()
    })

    it('deletes versions too', async () => {
      await store.store('ns', 'key1', 'v1')
      await store.update('ns', 'key1', 'v2')
      await store.forget('ns', 'key1')
      expect(await store.recall('ns', 'key1')).toBeNull()
    })
  })

  describe('list()', () => {
    it('returns empty array for empty namespace', async () => {
      const result = await store.list('ns')
      expect(result).toEqual([])
    })

    it('lists memories sorted by updated_at desc', async () => {
      await store.store('ns', 'a', 'first')
      await store.store('ns', 'b', 'second')
      const result = await store.list('ns')
      expect(result.length).toBe(2)
      expect(result[0].key).toBe('b')
    })

    it('filters by prefix', async () => {
      await store.store('ns', 'auth-config', 'c1')
      await store.store('ns', 'auth-keys', 'c2')
      await store.store('ns', 'db-schema', 'c3')
      const result = await store.list('ns', 'auth-')
      expect(result.length).toBe(2)
      expect(result.every(m => m.key.startsWith('auth-'))).toBe(true)
    })

    it('filters by tags', async () => {
      await store.store('ns', 'k1', 'c1', ['arch'])
      await store.store('ns', 'k2', 'c2', ['debug'])
      await store.store('ns', 'k3', 'c3', ['arch', 'debug'])
      const result = await store.list('ns', undefined, ['arch'])
      expect(result.length).toBe(2)
    })

    it('paginates with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.store('ns', `k${i}`, `content ${i}`)
      }
      const page1 = await store.list('ns', undefined, [], 2, 0)
      const page2 = await store.list('ns', undefined, [], 2, 2)
      expect(page1.length).toBe(2)
      expect(page2.length).toBe(2)
      expect(page1[0].key).not.toBe(page2[0].key)
    })
  })

  describe('validation', () => {
    it('rejects empty namespace', async () => {
      await expect(store.store('', 'key', 'content')).rejects.toThrow('namespace is required')
    })

    it('rejects empty key', async () => {
      await expect(store.store('ns', '', 'content')).rejects.toThrow('key is required')
    })

    it('rejects namespace over 255 chars', async () => {
      await expect(store.store('x'.repeat(256), 'key', 'c')).rejects.toThrow('255 characters')
    })

    it('rejects content over 100k chars', async () => {
      await expect(store.store('ns', 'key', 'x'.repeat(100001))).rejects.toThrow('100,000 characters')
    })
  })
})
```

**Step 2: Run tests**

Run: `cd packages/mcp-server && npx vitest run tests/store.test.js`

Expected: All pass.

**Step 3: Commit**

```bash
git add packages/mcp-server/tests/store.test.js
git commit -m "test: add store CRUD and validation tests"
```

---

### Task 6: Write search, namespace, and import/export tests

**Files:**
- Create: `packages/mcp-server/tests/search.test.js`
- Create: `packages/mcp-server/tests/advanced.test.js`

**Step 1: Write search tests**

```js
// packages/mcp-server/tests/search.test.js
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
    cosineSimilarity: () => 0,
  }
})

import { MemoryStore } from '../src/store.js'

describe('search', () => {
  let store

  beforeEach(() => {
    store = new MemoryStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('returns empty array when no memories match', async () => {
    const results = await store.search('ns', 'anything')
    expect(results).toEqual([])
  })

  it('returns results with score property', async () => {
    await store.store('ns', 'cats', 'cats are great pets')
    const results = await store.search('ns', 'cats')
    expect(results.length).toBe(1)
    expect(results[0].score).toBeDefined()
    expect(results[0].key).toBe('cats')
  })

  it('ranks similar content higher', async () => {
    await store.store('ns', 'cats', 'cats are wonderful furry pets')
    await store.store('ns', 'physics', 'quantum mechanics wave function')
    const results = await store.search('ns', 'furry cats pets')
    expect(results.length).toBe(2)
    expect(results[0].key).toBe('cats')
  })

  it('scopes search to namespace', async () => {
    await store.store('ns1', 'key1', 'shared content about cats')
    await store.store('ns2', 'key2', 'shared content about cats')
    const results = await store.search('ns1', 'cats')
    expect(results.length).toBe(1)
    expect(results[0].namespace).toBe('ns1')
  })

  it('filters by tags', async () => {
    await store.store('ns', 'k1', 'content about cats', ['animals'])
    await store.store('ns', 'k2', 'content about cats too', ['other'])
    const results = await store.search('ns', 'cats', 10, ['animals'])
    expect(results.length).toBe(1)
    expect(results[0].key).toBe('k1')
  })

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.store('ns', `k${i}`, `content about topic ${i}`)
    }
    const results = await store.search('ns', 'topic', 2)
    expect(results.length).toBe(2)
  })

  it('respects offset', async () => {
    for (let i = 0; i < 5; i++) {
      await store.store('ns', `k${i}`, `content about topic ${i}`)
    }
    const all = await store.search('ns', 'topic', 10)
    const offset = await store.search('ns', 'topic', 10, [], 2)
    expect(offset.length).toBe(all.length - 2)
    expect(offset[0].key).toBe(all[2].key)
  })

  it('rejects empty query', async () => {
    await expect(store.search('ns', '')).rejects.toThrow('query is required')
  })

  it('rejects empty namespace', async () => {
    await expect(store.search('', 'query')).rejects.toThrow('namespace is required')
  })
})
```

**Step 2: Write advanced feature tests**

```js
// packages/mcp-server/tests/advanced.test.js
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
    cosineSimilarity: () => 0,
  }
})

import { MemoryStore } from '../src/store.js'

describe('namespaces', () => {
  let store

  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('lists namespaces with counts', async () => {
    await store.store('ns1', 'k1', 'c1')
    await store.store('ns1', 'k2', 'c2')
    await store.store('ns2', 'k1', 'c3')
    const ns = await store.listNamespaces()
    expect(ns.length).toBe(2)
    expect(ns.find(n => n.namespace === 'ns1').count).toBe(2)
    expect(ns.find(n => n.namespace === 'ns2').count).toBe(1)
  })

  it('deleteNamespace dry run returns count', async () => {
    await store.store('ns1', 'k1', 'c1')
    await store.store('ns1', 'k2', 'c2')
    const result = await store.deleteNamespace('ns1', false)
    expect(result.confirmed).toBe(false)
    expect(result.count).toBe(2)
    // Memories still exist
    expect((await store.list('ns1')).length).toBe(2)
  })

  it('deleteNamespace with confirm deletes everything', async () => {
    await store.store('ns1', 'k1', 'c1')
    await store.store('ns1', 'k2', 'c2')
    const result = await store.deleteNamespace('ns1', true)
    expect(result.confirmed).toBe(true)
    expect(result.deleted).toBe(2)
    expect((await store.list('ns1')).length).toBe(0)
  })
})

describe('export / import', () => {
  let store

  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('exports and re-imports memories', async () => {
    await store.store('ns', 'k1', 'content1', ['tag1'])
    await store.store('ns', 'k2', 'content2')
    const exported = await store.exportNamespace('ns')

    expect(exported.export_version).toBe(1)
    expect(exported.count).toBe(2)
    expect(exported.memories.length).toBe(2)

    // Import into fresh store
    const store2 = new MemoryStore(':memory:')
    const result = await store2.importMemories(exported)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)

    const recalled = await store2.recall('ns', 'k1')
    expect(recalled.content).toBe('content1')
    expect(recalled.tags).toEqual(['tag1'])
    store2.close()
  })

  it('import skip mode skips existing keys', async () => {
    await store.store('ns', 'k1', 'original')
    const data = {
      export_version: 1,
      memories: [{ namespace: 'ns', key: 'k1', content: 'imported', tags: [], metadata: {} }],
    }
    const result = await store.importMemories(data, 'skip')
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(0)
    expect((await store.recall('ns', 'k1')).content).toBe('original')
  })

  it('import overwrite mode replaces existing keys', async () => {
    await store.store('ns', 'k1', 'original')
    const data = {
      export_version: 1,
      memories: [{ namespace: 'ns', key: 'k1', content: 'imported', tags: [], metadata: {} }],
    }
    const result = await store.importMemories(data, 'overwrite')
    expect(result.overwritten).toBe(1)
    expect((await store.recall('ns', 'k1')).content).toBe('imported')
  })

  it('export includes version history', async () => {
    await store.store('ns', 'k1', 'v1')
    await store.update('ns', 'k1', 'v2')
    const exported = await store.exportNamespace('ns')
    expect(exported.memories[0].versions.length).toBe(2)
    expect(exported.memories[0].versions[0].version).toBe(1)
    expect(exported.memories[0].versions[1].version).toBe(2)
  })

  it('export all namespaces when namespace omitted', async () => {
    await store.store('ns1', 'k1', 'c1')
    await store.store('ns2', 'k2', 'c2')
    const exported = await store.exportNamespace()
    expect(exported.count).toBe(2)
    expect(exported.namespace).toBe('all')
  })

  it('rejects unsupported export version', async () => {
    await expect(store.importMemories({ export_version: 99, memories: [] }))
      .rejects.toThrow('Unsupported export version')
  })
})

describe('summarize', () => {
  let store

  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('returns null for empty namespace', async () => {
    const result = await store.summarize('empty')
    expect(result).toBeNull()
  })

  it('returns summary with tag grouping', async () => {
    await store.store('ns', 'k1', 'content1', ['arch'])
    await store.store('ns', 'k2', 'content2', ['debug'])
    await store.store('ns', 'k3', 'content3')
    const summary = await store.summarize('ns')
    expect(summary.total_memories).toBe(3)
    expect(summary.by_tag.arch).toContain('k1')
    expect(summary.by_tag.debug).toContain('k2')
    expect(summary.untagged).toContain('k3')
    expect(summary.recent_updates.length).toBe(3)
  })
})

describe('stats', () => {
  let store

  beforeEach(() => { store = new MemoryStore(':memory:') })
  afterEach(() => { store.close() })

  it('tracks token usage', async () => {
    await store.store('ns', 'k1', 'hello world')
    const stats = await store.getStats()
    expect(stats.total_tokens_stored).toBeGreaterThan(0)
    expect(stats.total_memories).toBe(1)
    expect(stats.total_namespaces).toBe(1)
  })

  it('tracks tokens saved on recall', async () => {
    await store.store('ns', 'k1', 'hello world')
    await store.recall('ns', 'k1')
    const stats = await store.getStats()
    expect(stats.total_tokens_saved).toBeGreaterThan(0)
  })
})
```

**Step 3: Run all tests**

Run: `cd packages/mcp-server && npx vitest run`

Expected: All tests pass.

**Step 4: Commit**

```bash
git add packages/mcp-server/tests/
git commit -m "test: add search, namespace, import/export, summarize, and stats tests"
```

---

### Task 7: Update root package.json and final cleanup

**Files:**
- Modify: `packages/mcp-server/package.json` (version in root if needed)
- Modify: `README.md` — update storage section to mention better-sqlite3

**Step 1: Update root package.json version**

In root `package.json`, bump version to `0.3.0`.

**Step 2: Update README storage section**

In `README.md`, update the Storage section:

```markdown
## Storage

Memories are stored in a local SQLite database at `~/.agentmemory/memories.db` using better-sqlite3 with the sqlite-vec extension for fast vector search. The embedding model (`all-MiniLM-L6-v2`, ~23MB) downloads automatically on first use.
```

**Step 3: Run full test suite one final time**

Run: `cd packages/mcp-server && npx vitest run`

Expected: All tests pass.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: bump to v0.3.0, update README for better-sqlite3"
```
