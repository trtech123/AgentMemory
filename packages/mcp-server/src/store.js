/**
 * AgentMemory Store
 *
 * Local storage engine using better-sqlite3 + sqlite-vec
 * with semantic vector search via Transformers.js and TF-IDF fallback.
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
      this._dir = null
      this._dbPath = ':memory:'
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
        embedding BLOB,
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

    // Migrate existing DBs — add columns if missing
    try { this._db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB') } catch (e) {}
    try { this._db.exec('ALTER TABLE memory_versions ADD COLUMN tags TEXT') } catch (e) {}
    try { this._db.exec('ALTER TABLE memory_versions ADD COLUMN metadata TEXT') } catch (e) {}

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        namespace TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Create vec0 virtual table for vector search
    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
        id text primary key,
        embedding float[384]
      )
    `)

    // Backfill token counts for existing memories that predate usage_log
    const hasLogs = this._db.prepare('SELECT COUNT(*) as count FROM usage_log').get()
    if ((hasLogs?.count || 0) === 0) {
      const allMemories = this._db.prepare('SELECT namespace, content FROM memories').all()
      const insertLog = this._db.prepare(
        'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)'
      )
      for (const m of allMemories) {
        insertLog.run('store', m.namespace, Math.ceil(m.content.length / 4), new Date().toISOString())
      }
    }

    // Migration: backfill memory_embeddings from old embedding BLOB column
    this._migrateEmbeddingsToVec0()
  }

  _migrateEmbeddingsToVec0() {
    // Check if there are memories with embeddings in the BLOB column
    // that haven't been inserted into the vec0 table yet
    const rows = this._db.prepare(
      `SELECT m.id, m.embedding FROM memories m
       WHERE m.embedding IS NOT NULL
       AND m.id NOT IN (SELECT id FROM memory_embeddings)`
    ).all()

    if (rows.length === 0) return

    const insertVec = this._db.prepare(
      'INSERT INTO memory_embeddings(id, embedding) VALUES (?, ?)'
    )
    const migrate = this._db.transaction(() => {
      for (const row of rows) {
        try {
          insertVec.run(row.id, row.embedding)
        } catch (e) {
          // Skip rows with invalid embeddings
        }
      }
    })
    migrate()
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
    // Tags are stored as JSON arrays, so we match the JSON-encoded form
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
    const buf = vectorToBuffer(vector)
    // Delete old embedding if it exists, then insert new one
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

    // Compute and store embedding in vec0 table
    const vector = await embed(`${key} ${content}`)
    if (vector) {
      this._upsertEmbedding(id, vector)
    }

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

    // Try embedding-based search first using sqlite-vec KNN
    if (embeddingsReady()) {
      const queryVec = await embed(query)
      if (queryVec) {
        const queryBuf = vectorToBuffer(queryVec)
        // Over-fetch from vec0 to account for namespace/tag filtering
        const knnLimit = Math.max(50, limit * 5)
        const vecResults = this._db.prepare(
          'SELECT id, distance FROM memory_embeddings WHERE embedding MATCH ? AND k = ?'
        ).all(queryBuf, knnLimit)

        if (vecResults.length > 0) {
          // Build a set of candidate IDs
          const distanceMap = new Map()
          for (const vr of vecResults) {
            distanceMap.set(vr.id, vr.distance)
          }

          const candidateIds = vecResults.map(vr => vr.id)
          const placeholders = candidateIds.map(() => '?').join(',')

          // Filter by namespace and tags
          let sql = `SELECT * FROM memories WHERE id IN (${placeholders}) AND namespace = ?`
          const params = [...candidateIds, namespace]

          for (const tag of tags) {
            sql += ' AND tags LIKE ?'
            params.push(this._escapeTagFilter(tag))
          }

          const rows = this._db.prepare(sql).all(...params)

          // Score = 1 / (1 + distance) and sort
          const scored = rows.map(row => ({
            ...this._formatRow(row),
            score: 1 / (1 + distanceMap.get(row.id)),
          }))

          scored.sort((a, b) => b.score - a.score)
          const results = scored.slice(offset, offset + limit)

          const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
          this._logUsage('search', namespace, tokensSaved)
          return results
        }
      }
    }

    // Fallback: TF-IDF term matching
    const queryTokens = this._tokenize(query)

    // Build base WHERE clause for namespace + tags
    let whereClause = 'WHERE namespace = ?'
    const whereParams = [namespace]
    for (const tag of tags) {
      whereClause += ' AND tags LIKE ?'
      whereParams.push(this._escapeTagFilter(tag))
    }

    if (queryTokens.length === 0) {
      const rows = this._db.prepare(
        `SELECT * FROM memories ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      ).all(...whereParams, limit, offset)
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

    // Re-compute embedding in vec0 table
    const vector = await embed(`${key} ${content}`)
    if (vector) {
      this._upsertEmbedding(existing.id, vector)
    }

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

    this._db.prepare('DELETE FROM search_index WHERE memory_id = ?').run(existing.id)
    this._db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(existing.id)
    this._db.prepare('DELETE FROM memory_embeddings WHERE id = ?').run(existing.id)
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

    const rows = this._db.prepare(sql).all(...params)
    return rows.map(row => this._formatRow(row))
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
      this._db.prepare('DELETE FROM search_index WHERE memory_id = ?').run(m.id)
      this._db.prepare('DELETE FROM memory_versions WHERE memory_id = ?').run(m.id)
      this._db.prepare('DELETE FROM memory_embeddings WHERE id = ?').run(m.id)
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

    if (!total || total.count === 0) {
      return null
    }

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
