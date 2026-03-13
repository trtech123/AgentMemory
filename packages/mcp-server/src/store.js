/**
 * AgentMemory Store
 *
 * Local storage engine using sql.js (WASM SQLite — no native deps)
 * with semantic vector search via Transformers.js and TF-IDF fallback.
 */

import initSqlJs from 'sql.js'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { embed, isReady as embeddingsReady, cosineSimilarity, vectorToBuffer, bufferToVector } from './embeddings.js'
import { summarize, mergeAndSummarize, SUMMARY_THRESHOLD } from './summarizer.js'

const MAX_VERSIONS = 20
const USAGE_LOG_TTL_DAYS = 90
const DEFAULT_DB_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.agentmemory')

// sql.js query helpers — convert stmt-based API into better-sqlite3-like .get/.all
function queryGet(db, sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  let row = null
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]))
  }
  stmt.free()
  return row
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])))
  }
  stmt.free()
  return rows
}

function queryRun(db, sql, params = []) {
  db.run(sql, params)
}

export class MemoryStore {
  async init() {
    const SQL = await initSqlJs()

    if (this._dbPath === ':memory:') {
      this._db = new SQL.Database()
    } else {
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

      if (existsSync(this._dbPath)) {
        this._db = new SQL.Database(readFileSync(this._dbPath))
      } else {
        this._db = new SQL.Database()
      }
    }

    this._initSchema()

    // Auto-persist every 5 seconds
    if (this._dbPath !== ':memory:') {
      this._persistInterval = setInterval(() => this.persist(), 5000)
    }
  }

  constructor(dbPath) {
    if (dbPath === ':memory:') {
      this._dir = null
      this._dbPath = ':memory:'
    } else {
      this._dir = dbPath || DEFAULT_DB_DIR
      this._dbPath = join(this._dir, 'memories.db')
      if (!existsSync(this._dir)) mkdirSync(this._dir, { recursive: true })
    }
    this._db = null
    this._persistInterval = null
  }

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

  _initSchema() {
    const db = this._db

    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        embedding TEXT,
        version INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, key)
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(namespace, key)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)`)

    db.run(`
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

    db.run(`CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, version)`)

    db.run(`
      CREATE TABLE IF NOT EXISTS search_index (
        memory_id TEXT NOT NULL,
        term TEXT NOT NULL,
        tf REAL NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_search_term ON search_index(term)`)

    // Migrate existing DBs — add columns if missing
    try { db.run('ALTER TABLE memories ADD COLUMN embedding TEXT') } catch (e) {}
    try { db.run('ALTER TABLE memory_versions ADD COLUMN tags TEXT') } catch (e) {}
    try { db.run('ALTER TABLE memory_versions ADD COLUMN metadata TEXT') } catch (e) {}
    try { db.run('ALTER TABLE memories ADD COLUMN summary TEXT') } catch (e) {}

    db.run(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        namespace TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Backfill token counts for existing memories that predate usage_log
    const hasLogs = queryGet(db, 'SELECT COUNT(*) as count FROM usage_log')
    if ((hasLogs?.count || 0) === 0) {
      const allMemories = queryAll(db, 'SELECT namespace, content FROM memories')
      for (const m of allMemories) {
        queryRun(db,
          'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)',
          [('store'), m.namespace, Math.ceil(m.content.length / 4), new Date().toISOString()]
        )
      }
    }

    // Prune old usage logs
    db.run(`DELETE FROM usage_log WHERE created_at < datetime('now', '-' || ? || ' days')`, [USAGE_LOG_TTL_DAYS])
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
    if (namespace.length > 255) {
      throw new Error('namespace must be 255 characters or less')
    }
    if (key.length > 255) {
      throw new Error('key must be 255 characters or less')
    }
    if (content !== undefined && content !== null) {
      if (typeof content !== 'string') {
        throw new Error('content must be a string')
      }
      if (content.length > 100000) {
        throw new Error('content must be 100,000 characters or less')
      }
    }
  }

  _escapeTagFilter(tag) {
    return `%${JSON.stringify(tag)}%`
  }

  _indexMemory(memoryId, content) {
    queryRun(this._db, 'DELETE FROM search_index WHERE memory_id = ?', [memoryId])
    const tokens = this._tokenize(content)
    if (tokens.length === 0) return

    const freq = {}
    for (const token of tokens) {
      freq[token] = (freq[token] || 0) + 1
    }

    for (const [term, count] of Object.entries(freq)) {
      queryRun(this._db,
        'INSERT INTO search_index (memory_id, term, tf) VALUES (?, ?, ?)',
        [memoryId, term, count / tokens.length]
      )
    }
  }

  _pruneVersions(memoryId) {
    queryRun(this._db,
      `DELETE FROM memory_versions WHERE memory_id = ? AND id NOT IN (
        SELECT id FROM memory_versions WHERE memory_id = ?
        ORDER BY version DESC LIMIT ?
      )`,
      [memoryId, memoryId, MAX_VERSIONS]
    )
  }

  _ensureSearchIndex(namespace) {
    const hasIndex = queryGet(this._db,
      `SELECT 1 as found FROM search_index si
       JOIN memories m ON m.id = si.memory_id
       WHERE m.namespace = ? LIMIT 1`,
      [namespace]
    )
    if (!hasIndex) {
      const memories = queryAll(this._db,
        'SELECT id, key, content, tags FROM memories WHERE namespace = ?',
        [namespace]
      )
      for (const m of memories) {
        const tags = JSON.parse(m.tags || '[]')
        this._indexMemory(m.id, `${m.key} ${m.content} ${tags.join(' ')}`)
      }
    }
  }

  _upsertEmbedding(memoryId, vector) {
    // Store embedding as JSON text in the memories table
    const embeddingJson = JSON.stringify(vector)
    queryRun(this._db,
      'UPDATE memories SET embedding = ? WHERE id = ?',
      [embeddingJson, memoryId]
    )
  }

  _formatRow(row) {
    return {
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      content: row.content,
      summary: row.summary || null,
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
    queryRun(this._db,
      'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)',
      [operation, namespace || null, tokensUsed, new Date().toISOString()]
    )
  }

  async store(namespace, key, content, tags = [], metadata = {}) {
    this._validate(namespace, key, content)

    const existing = queryGet(this._db,
      'SELECT id, version FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (existing) {
      return this.update(namespace, key, content, tags, metadata)
    }

    const id = this._generateId()
    const versionId = this._generateId()
    const now = new Date().toISOString()
    const summary = content.length > SUMMARY_THRESHOLD ? summarize(content) : null
    const tagsJson = JSON.stringify(tags)
    const metaJson = JSON.stringify(metadata)
    const tokens = this._estimateTokens(content)

    // Async embedding
    const vector = await embed(`${key} ${content}`)

    queryRun(this._db,
      `INSERT INTO memories (id, namespace, key, content, summary, tags, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, namespace, key, content, summary, tagsJson, metaJson, now, now]
    )

    if (vector) {
      this._upsertEmbedding(id, vector)
    } else {
      this._indexMemory(id, `${key} ${content} ${tags.join(' ')}`)
    }

    queryRun(this._db,
      `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [versionId, id, content, tagsJson, metaJson, now]
    )

    this._logUsage('store', namespace, tokens)
    this.persist()

    return { id, namespace, key, version: 1, created_at: now, tokens }
  }

  async search(namespace, query, limit = 10, tags = [], offset = 0) {
    if (!namespace || typeof namespace !== 'string' || namespace.trim() === '') {
      throw new Error('namespace is required and must be a non-empty string')
    }
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new Error('query is required and must be a non-empty string')
    }

    // Try embedding-based search first — in-memory cosine similarity
    if (embeddingsReady()) {
      const queryVec = await embed(query)
      if (queryVec) {
        // Get all memories with embeddings in this namespace
        let sql = 'SELECT * FROM memories WHERE namespace = ? AND embedding IS NOT NULL'
        const params = [namespace]

        for (const tag of tags) {
          sql += ' AND tags LIKE ?'
          params.push(this._escapeTagFilter(tag))
        }

        const rows = queryAll(this._db, sql, params)

        if (rows.length > 0) {
          // Score each by cosine similarity
          const scored = rows.map(row => {
            const storedVec = JSON.parse(row.embedding)
            const score = cosineSimilarity(queryVec, storedVec)
            return { ...this._formatRow(row), score }
          })

          scored.sort((a, b) => b.score - a.score)
          const results = scored.slice(offset, offset + limit)

          const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
          this._logUsage('search', namespace, tokensSaved)
          this.persist()
          return results
        }
      }
    }

    // Fallback: TF-IDF term matching
    this._ensureSearchIndex(namespace)
    const queryTokens = this._tokenize(query)

    let whereClause = 'WHERE namespace = ?'
    const whereParams = [namespace]
    for (const tag of tags) {
      whereClause += ' AND tags LIKE ?'
      whereParams.push(this._escapeTagFilter(tag))
    }

    if (queryTokens.length === 0) {
      const rows = queryAll(this._db,
        `SELECT * FROM memories ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        [...whereParams, limit, offset]
      )
      return rows.map(row => this._formatRow(row))
    }

    const placeholders = queryTokens.map(() => '?').join(',')
    const sql = `
      SELECT m.*, SUM(si.tf) as score
      FROM search_index si
      JOIN memories m ON m.id = si.memory_id
      WHERE si.term IN (${placeholders})
      AND m.namespace = ?
      ${tags.map(() => ' AND m.tags LIKE ?').join('')}
      GROUP BY m.id ORDER BY score DESC LIMIT ? OFFSET ?
    `
    const params = [...queryTokens, namespace, ...tags.map(t => this._escapeTagFilter(t)), limit, offset]
    const rows = queryAll(this._db, sql, params)
    const results = rows.map(row => this._formatRow(row))

    const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
    this._logUsage('search', namespace, tokensSaved)
    this.persist()
    return results
  }

  async recall(namespace, key, version) {
    this._validate(namespace, key)

    if (version) {
      const memory = queryGet(this._db,
        'SELECT * FROM memories WHERE namespace = ? AND key = ?',
        [namespace, key]
      )
      if (!memory) return null

      const versionRow = queryGet(this._db,
        'SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?',
        [memory.id, version]
      )

      if (versionRow) {
        const result = this._formatRow(memory)
        result.content = versionRow.content
        result.version = versionRow.version
        if (versionRow.tags) result.tags = JSON.parse(versionRow.tags)
        if (versionRow.metadata) result.metadata = JSON.parse(versionRow.metadata)
        this._logUsage('recall', namespace, this._estimateTokens(result.content))
        this.persist()
        return result
      }
    }

    const row = queryGet(this._db,
      'SELECT * FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )
    if (!row) return null

    const result = this._formatRow(row)
    this._logUsage('recall', namespace, this._estimateTokens(result.content))
    this.persist()
    return result
  }

  async update(namespace, key, content, tags, metadata) {
    this._validate(namespace, key, content)

    const existing = queryGet(this._db,
      'SELECT * FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (!existing) {
      return this.store(namespace, key, content, tags, metadata)
    }

    const now = new Date().toISOString()
    const versionId = this._generateId()
    const newVersion = existing.version + 1
    const newTags = tags !== undefined ? JSON.stringify(tags) : existing.tags
    const newMeta = metadata !== undefined
      ? JSON.stringify({ ...JSON.parse(existing.metadata), ...metadata })
      : existing.metadata
    const newSummary = content.length > SUMMARY_THRESHOLD ? summarize(content) : null
    const tokens = this._estimateTokens(content)

    // Async embedding
    const vector = await embed(`${key} ${content}`)

    queryRun(this._db,
      `UPDATE memories SET content = ?, summary = ?, tags = ?, metadata = ?, version = ?, updated_at = ?
       WHERE id = ?`,
      [content, newSummary, newTags, newMeta, newVersion, now, existing.id]
    )

    if (vector) {
      this._upsertEmbedding(existing.id, vector)
    } else {
      this._indexMemory(existing.id, `${key} ${content} ${(tags || []).join(' ')}`)
    }

    queryRun(this._db,
      `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [versionId, existing.id, content, newTags, newMeta, newVersion, now]
    )

    this._pruneVersions(existing.id)
    this._logUsage('update', namespace, tokens)
    this.persist()

    return { id: existing.id, namespace, key, version: newVersion, updated_at: now, tokens }
  }

  async forget(namespace, key) {
    this._validate(namespace, key)

    const existing = queryGet(this._db,
      'SELECT id FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (!existing) return false

    queryRun(this._db, 'DELETE FROM search_index WHERE memory_id = ?', [existing.id])
    queryRun(this._db, 'DELETE FROM memory_versions WHERE memory_id = ?', [existing.id])
    queryRun(this._db, 'DELETE FROM memories WHERE id = ?', [existing.id])
    this.persist()
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

    const rows = queryAll(this._db, sql, params)
    return rows.map(row => this._formatRow(row))
  }

  async listNamespaces() {
    return queryAll(this._db,
      'SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY namespace'
    )
  }

  async getStats() {
    const tokensStored = queryGet(this._db,
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('store', 'update')"
    )
    const tokensSaved = queryGet(this._db,
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('search', 'recall')"
    )
    const memoryCount = queryGet(this._db, 'SELECT COUNT(*) as count FROM memories')
    const namespaceCount = queryGet(this._db, 'SELECT COUNT(DISTINCT namespace) as count FROM memories')

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
      const count = queryGet(this._db,
        'SELECT COUNT(*) as count FROM memories WHERE namespace = ?',
        [namespace]
      )
      return { confirmed: false, count: count?.count || 0 }
    }

    const count = queryGet(this._db,
      'SELECT COUNT(*) as count FROM memories WHERE namespace = ?',
      [namespace]
    )?.count || 0

    queryRun(this._db,
      'DELETE FROM search_index WHERE memory_id IN (SELECT id FROM memories WHERE namespace = ?)',
      [namespace]
    )
    queryRun(this._db,
      'DELETE FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE namespace = ?)',
      [namespace]
    )
    queryRun(this._db, 'DELETE FROM memories WHERE namespace = ?', [namespace])
    queryRun(this._db, 'DELETE FROM usage_log WHERE namespace = ?', [namespace])
    this.persist()

    return { confirmed: true, deleted: count }
  }

  async exportNamespace(namespace) {
    let sql = 'SELECT * FROM memories'
    const params = []

    if (namespace) {
      sql += ' WHERE namespace = ?'
      params.push(namespace)
    }

    sql += ' ORDER BY namespace, key'
    const memories = queryAll(this._db, sql, params)

    const exported = memories.map(row => {
      const formatted = this._formatRow(row)

      const versions = queryAll(this._db,
        'SELECT content, tags, metadata, version, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version',
        [row.id]
      )
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
      const existing = queryGet(this._db,
        'SELECT id FROM memories WHERE namespace = ? AND key = ?',
        [memory.namespace, memory.key]
      )

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

    const total = queryGet(this._db,
      'SELECT COUNT(*) as count FROM memories WHERE namespace = ?',
      [namespace]
    )

    if (!total || total.count === 0) {
      return null
    }

    const memories = queryAll(this._db,
      'SELECT key, tags, version, updated_at, LENGTH(content) as content_length FROM memories WHERE namespace = ? ORDER BY updated_at DESC',
      [namespace]
    )

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

    const tokenTotal = queryGet(this._db,
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('store', 'update') AND namespace = ?",
      [namespace]
    )

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

  compress(text, ratio) {
    return summarize(text, ratio)
  }

  async snapshot(namespace, key, content, tags = [], metadata = {}) {
    const snapshotTags = [...new Set([...tags, 'session-snapshot'])]
    return this.store(namespace, key, content, snapshotTags, metadata)
  }

  async bulkRecall(namespace, keys = [], tags = [], ratio) {
    let memories
    if (keys.length > 0) {
      const placeholders = keys.map(() => '?').join(',')
      let sql = `SELECT * FROM memories WHERE namespace = ? AND key IN (${placeholders})`
      const params = [namespace, ...keys]
      memories = queryAll(this._db, sql, params)
    } else if (tags.length > 0) {
      let sql = 'SELECT * FROM memories WHERE namespace = ?'
      const params = [namespace]
      for (const tag of tags) {
        sql += ' AND tags LIKE ?'
        params.push(this._escapeTagFilter(tag))
      }
      sql += ' ORDER BY updated_at DESC'
      memories = queryAll(this._db, sql, params)
    } else {
      throw new Error('Either keys or tags must be provided for bulk recall')
    }

    if (memories.length === 0) return { items: [], merged: '' }

    const items = memories.map(row => this._formatRow(row))
    const merged = mergeAndSummarize(
      items.map(m => ({ key: m.key, content: m.content })),
      ratio
    )

    const tokensSaved = items.reduce((sum, m) => sum + this._estimateTokens(m.content), 0)
    const tokensReturned = this._estimateTokens(merged)
    this._logUsage('bulk_recall', namespace, tokensSaved)
    this.persist()

    return {
      items: items.map(m => ({ key: m.key, version: m.version, tags: m.tags })),
      merged,
      stats: {
        memories_count: items.length,
        original_tokens: tokensSaved,
        compressed_tokens: tokensReturned,
        compression_ratio: tokensSaved > 0 ? (tokensReturned / tokensSaved).toFixed(2) : '1.00',
      },
    }
  }

  close() {
    if (this._persistInterval) {
      clearInterval(this._persistInterval)
    }
    if (this._db) {
      this.persist()
      this._db.close()
    }
  }
}
