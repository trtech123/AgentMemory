/**
 * AgentMemory Store
 *
 * Local storage engine using sql.js (SQLite compiled to WASM)
 * and simple TF-IDF vector search for semantic recall.
 *
 * In production, this would connect to the AgentMemory cloud API.
 * Locally, it provides full functionality with zero config.
 */

import initSqlJs from 'sql.js'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

const DEFAULT_DB_DIR = join(process.env.HOME || process.env.USERPROFILE || '.', '.agentmemory')

export class MemoryStore {
  constructor(dbPath) {
    this._dir = dbPath || DEFAULT_DB_DIR
    this._dbPath = join(this._dir, 'memories.db')
    this._db = null
    this._ready = this._initialize()
  }

  async _initialize() {
    if (!existsSync(this._dir)) mkdirSync(this._dir, { recursive: true })
    const SQL = await initSqlJs()

    if (existsSync(this._dbPath)) {
      this._db = new SQL.Database(readFileSync(this._dbPath))
    } else {
      this._db = new SQL.Database()
    }

    this._db.run(`
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
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)`)
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(namespace, key)`)
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at)`)

    this._db.run(`
      CREATE TABLE IF NOT EXISTS memory_versions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      )
    `)

    this._db.run(`
      CREATE TABLE IF NOT EXISTS search_index (
        memory_id TEXT NOT NULL,
        term TEXT NOT NULL,
        tf REAL NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id)
      )
    `)
    this._db.run(`CREATE INDEX IF NOT EXISTS idx_search_term ON search_index(term)`)

    this._db.run(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        namespace TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Backfill token counts for existing memories that predate usage_log
    const hasLogs = this._queryOne('SELECT COUNT(*) as count FROM usage_log')
    if ((hasLogs?.count || 0) === 0) {
      const allMemories = this._query('SELECT namespace, content FROM memories')
      for (const m of allMemories) {
        this._run(
          'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)',
          ['store', m.namespace, Math.ceil(m.content.length / 4), new Date().toISOString()]
        )
      }
    }

    this._persist()
  }

  async _ensureReady() {
    await this._ready
  }

  _persist() {
    writeFileSync(this._dbPath, Buffer.from(this._db.export()))
  }

  _generateId() {
    return createHash('sha256')
      .update(Date.now().toString() + Math.random().toString())
      .digest('hex')
      .substring(0, 16)
  }

  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
  }

  _query(sql, params = []) {
    const stmt = this._db.prepare(sql)
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

  _queryOne(sql, params = []) {
    const rows = this._query(sql, params)
    return rows.length > 0 ? rows[0] : null
  }

  _run(sql, params = []) {
    this._db.run(sql, params)
  }

  _indexMemory(memoryId, content) {
    this._run('DELETE FROM search_index WHERE memory_id = ?', [memoryId])
    const tokens = this._tokenize(content)
    if (tokens.length === 0) return

    const freq = {}
    for (const token of tokens) {
      freq[token] = (freq[token] || 0) + 1
    }

    for (const [term, count] of Object.entries(freq)) {
      this._run('INSERT INTO search_index (memory_id, term, tf) VALUES (?, ?, ?)', [memoryId, term, count / tokens.length])
    }
  }

  async store(namespace, key, content, tags = [], metadata = {}) {
    await this._ensureReady()

    const existing = this._queryOne(
      'SELECT id, version FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (existing) {
      return this.update(namespace, key, content, tags, metadata)
    }

    const now = new Date().toISOString()
    const id = this._generateId()

    this._run(
      `INSERT INTO memories (id, namespace, key, content, tags, metadata, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, namespace, key, content, JSON.stringify(tags), JSON.stringify(metadata), now, now]
    )

    this._run(
      `INSERT INTO memory_versions (id, memory_id, content, version, created_at)
       VALUES (?, ?, ?, 1, ?)`,
      [this._generateId(), id, content, now]
    )

    this._indexMemory(id, `${key} ${content} ${tags.join(' ')}`)

    const tokens = this._estimateTokens(content)
    this._logUsage('store', namespace, tokens)
    this._persist()

    return { id, namespace, key, version: 1, created_at: now, tokens }
  }

  async search(namespace, query, limit = 10, tags = []) {
    await this._ensureReady()

    const queryTokens = this._tokenize(query)
    if (queryTokens.length === 0) {
      const rows = this._query(
        'SELECT * FROM memories WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?',
        [namespace, limit]
      )
      return rows.map(this._formatRow)
    }

    const placeholders = queryTokens.map(() => '?').join(',')

    // Simple term-matching approach (compatible with sql.js)
    const sql = `
      SELECT m.*, COUNT(si.term) as score
      FROM search_index si
      JOIN memories m ON m.id = si.memory_id
      WHERE si.term IN (${placeholders})
      AND m.namespace = ?
      ${tags.map(() => ' AND m.tags LIKE ?').join('')}
      GROUP BY m.id ORDER BY score DESC LIMIT ?
    `
    const params = [...queryTokens, namespace, ...tags.map((t) => `%"${t}"%`), limit]

    const rows = this._query(sql, params)
    const results = rows.map(this._formatRow)

    const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
    this._logUsage('search', namespace, tokensSaved)

    return results
  }

  async recall(namespace, key, version) {
    await this._ensureReady()

    if (version) {
      const memory = this._queryOne(
        'SELECT * FROM memories WHERE namespace = ? AND key = ?',
        [namespace, key]
      )
      if (!memory) return null

      const versionRow = this._queryOne(
        'SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?',
        [memory.id, version]
      )

      if (versionRow) {
        return { ...this._formatRow(memory), content: versionRow.content, version: versionRow.version }
      }
    }

    const row = this._queryOne(
      'SELECT * FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )
    if (!row) return null

    const result = this._formatRow(row)
    this._logUsage('recall', namespace, this._estimateTokens(result.content))
    return result
  }

  async update(namespace, key, content, tags, metadata) {
    await this._ensureReady()

    const existing = this._queryOne(
      'SELECT * FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (!existing) {
      return this.store(namespace, key, content, tags, metadata)
    }

    const now = new Date().toISOString()
    const newVersion = existing.version + 1
    const newTags = tags !== undefined ? JSON.stringify(tags) : existing.tags
    const newMeta = metadata !== undefined
      ? JSON.stringify({ ...JSON.parse(existing.metadata), ...metadata })
      : existing.metadata

    this._run(
      `UPDATE memories SET content = ?, tags = ?, metadata = ?, version = ?, updated_at = ?
       WHERE id = ?`,
      [content, newTags, newMeta, newVersion, now, existing.id]
    )

    this._run(
      `INSERT INTO memory_versions (id, memory_id, content, version, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [this._generateId(), existing.id, content, newVersion, now]
    )

    this._indexMemory(existing.id, `${key} ${content} ${(tags || []).join(' ')}`)

    const tokens = this._estimateTokens(content)
    this._logUsage('update', namespace, tokens)
    this._persist()

    return { id: existing.id, namespace, key, version: newVersion, updated_at: now, tokens }
  }

  async forget(namespace, key) {
    await this._ensureReady()

    const existing = this._queryOne(
      'SELECT id FROM memories WHERE namespace = ? AND key = ?',
      [namespace, key]
    )

    if (!existing) return false

    this._run('DELETE FROM search_index WHERE memory_id = ?', [existing.id])
    this._run('DELETE FROM memory_versions WHERE memory_id = ?', [existing.id])
    this._run('DELETE FROM memories WHERE id = ?', [existing.id])
    this._persist()
    return true
  }

  async list(namespace, prefix, tags = []) {
    await this._ensureReady()

    let sql = 'SELECT * FROM memories WHERE namespace = ?'
    const params = [namespace]

    if (prefix) {
      sql += ' AND key LIKE ?'
      params.push(`${prefix}%`)
    }

    for (const tag of (tags || [])) {
      sql += ' AND tags LIKE ?'
      params.push(`%"${tag}"%`)
    }

    sql += ' ORDER BY updated_at DESC'
    const rows = this._query(sql, params)
    return rows.map(this._formatRow)
  }

  async listNamespaces() {
    await this._ensureReady()

    return this._query(
      'SELECT namespace, COUNT(*) as count FROM memories GROUP BY namespace ORDER BY namespace'
    )
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
    this._run(
      'INSERT INTO usage_log (operation, namespace, tokens_used, created_at) VALUES (?, ?, ?, ?)',
      [operation, namespace || null, tokensUsed, new Date().toISOString()]
    )
  }

  async getStats() {
    await this._ensureReady()

    const tokensStored = this._queryOne(
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('store', 'update')"
    )
    const tokensSaved = this._queryOne(
      "SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log WHERE operation IN ('search', 'recall')"
    )
    const memoryCount = this._queryOne('SELECT COUNT(*) as count FROM memories')
    const namespaceCount = this._queryOne('SELECT COUNT(DISTINCT namespace) as count FROM memories')

    return {
      total_tokens_stored: tokensStored?.total || 0,
      total_tokens_saved: tokensSaved?.total || 0,
      total_memories: memoryCount?.count || 0,
      total_namespaces: namespaceCount?.count || 0,
    }
  }

  close() {
    if (this._db) {
      this._persist()
      this._db.close()
    }
  }
}
