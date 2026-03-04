# AgentMemory MCP Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform AgentMemory from a multi-package product into a single MCP-only, local-only memory server with semantic search via Transformers.js.

**Architecture:** Enhance the existing MCP server in-place (3 source files: index.js, store.js, embeddings.js). Delete all other packages (API, SDKs, docs site). Local SQLite via sql.js, semantic embeddings via @huggingface/transformers with all-MiniLM-L6-v2.

**Tech Stack:** Node.js ESM, @modelcontextprotocol/sdk, sql.js, @huggingface/transformers

---

### Task 1: Delete unused packages

**Files:**
- Delete: `packages/api/` (entire directory)
- Delete: `packages/sdk-ts/` (entire directory)
- Delete: `packages/sdk-py/` (entire directory)
- Delete: `packages/docs/` (entire directory)
- Modify: `package.json` (root)

**Step 1: Remove the four unused package directories**

```bash
rm -rf packages/api packages/sdk-ts packages/sdk-py packages/docs
```

**Step 2: Update root package.json**

Remove the `workspaces` field since there's only one package now. Update description:

```json
{
  "name": "agentmemory",
  "version": "0.2.0",
  "private": true,
  "description": "MCP server — persistent, searchable memory for AI agents"
}
```

**Step 3: Verify only mcp-server remains**

Run: `ls packages/`
Expected: Only `mcp-server` listed.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove API server, SDKs, and docs site — MCP-only now"
```

---

### Task 2: Create embeddings.js — Transformers.js wrapper

**Files:**
- Create: `packages/mcp-server/src/embeddings.js`

**Step 1: Write the embeddings module**

```javascript
/**
 * Embeddings engine using Transformers.js
 * Lazy-loads all-MiniLM-L6-v2 on first use. Fully local, no API keys.
 */

import { pipeline } from '@huggingface/transformers'

let _embedder = null
let _loading = false
let _ready = false

/**
 * Lazy-initialize the embedding pipeline.
 * Returns true if ready, false if still loading.
 */
export async function ensureReady() {
  if (_ready) return true
  if (_loading) return false
  _loading = true
  try {
    _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    })
    _ready = true
    return true
  } catch (err) {
    console.error('Failed to load embedding model:', err.message)
    _loading = false
    return false
  }
}

/**
 * Embed a text string into a 384-dim float32 vector.
 * Returns null if model not loaded yet.
 */
export async function embed(text) {
  if (!_ready) {
    const loaded = await ensureReady()
    if (!loaded) return null
  }
  const output = await _embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Check if embeddings engine is ready (model loaded).
 */
export function isReady() {
  return _ready
}

/**
 * Serialize a float32 vector to a Buffer for SQLite BLOB storage.
 */
export function vectorToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer)
}

/**
 * Deserialize a Buffer (SQLite BLOB) back to a float32 array.
 */
export function bufferToVector(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}
```

**Step 2: Run a quick smoke test**

Run: `cd packages/mcp-server && node -e "import('./src/embeddings.js').then(async m => { await m.ensureReady(); const v = await m.embed('hello world'); console.log('dims:', v.length, 'sample:', v.slice(0,3)); })"`
Expected: `dims: 384 sample: [0.xxx, 0.xxx, 0.xxx]` (first run downloads ~23MB model)

**Step 3: Commit**

```bash
git add packages/mcp-server/src/embeddings.js
git commit -m "feat: add embeddings.js — Transformers.js wrapper for local semantic search"
```

---

### Task 3: Add @huggingface/transformers dependency

**Files:**
- Modify: `packages/mcp-server/package.json`

**Step 1: Install the dependency**

```bash
cd packages/mcp-server
npm install @huggingface/transformers
```

**Step 2: Verify package.json has 3 dependencies**

Run: `cat packages/mcp-server/package.json | grep -A5 dependencies`
Expected: `@modelcontextprotocol/sdk`, `sql.js`, `@huggingface/transformers`

**Step 3: Commit**

```bash
git add packages/mcp-server/package.json packages/mcp-server/package-lock.json
git commit -m "chore: add @huggingface/transformers dependency"
```

---

### Task 4: Update database schema — add embedding column and expand versions

**Files:**
- Modify: `packages/mcp-server/src/store.js:36-63` (the _initialize method)

**Step 1: Update _initialize to add embedding BLOB column and version tags/metadata**

In `store.js`, update the `memories` CREATE TABLE to include the `embedding` column:

```sql
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
```

Update the `memory_versions` CREATE TABLE to include tags and metadata:

```sql
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
```

Add migration logic after table creation for existing databases:

```javascript
// Migrate existing DBs: add embedding column if missing
try {
  this._db.run('ALTER TABLE memories ADD COLUMN embedding BLOB')
} catch (e) {
  // Column already exists — ignore
}
try {
  this._db.run('ALTER TABLE memory_versions ADD COLUMN tags TEXT')
} catch (e) {}
try {
  this._db.run('ALTER TABLE memory_versions ADD COLUMN metadata TEXT')
} catch (e) {}
```

**Step 2: Verify the server still starts**

Run: `cd packages/mcp-server && node -e "import('./src/store.js').then(m => { const s = new m.MemoryStore(); s._ready.then(() => { console.log('OK'); s.close(); }); })"`
Expected: `OK`

**Step 3: Commit**

```bash
git add packages/mcp-server/src/store.js
git commit -m "feat: add embedding BLOB column and expand version history schema"
```

---

### Task 5: Integrate embeddings into store/update

**Files:**
- Modify: `packages/mcp-server/src/store.js:1-12` (imports)
- Modify: `packages/mcp-server/src/store.js:160-194` (store method)
- Modify: `packages/mcp-server/src/store.js:262-299` (update method)

**Step 1: Add embeddings import at top of store.js**

```javascript
import { embed, ensureReady as ensureEmbeddings, vectorToBuffer, bufferToVector, cosineSimilarity, isReady as embeddingsReady } from './embeddings.js'
```

**Step 2: Update the store() method to compute and save embedding**

After the INSERT INTO memories, before `_indexMemory`:

```javascript
// Compute embedding (non-blocking — fires in background on first call)
ensureEmbeddings()
const vector = await embed(`${key} ${content}`)
if (vector) {
  this._run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBuffer(vector), id])
}
```

**Step 3: Update the update() method to re-embed**

After the UPDATE memories SET, before `_indexMemory`:

```javascript
const vector = await embed(`${key} ${content}`)
if (vector) {
  this._run('UPDATE memories SET embedding = ? WHERE id = ?', [vectorToBuffer(vector), existing.id])
}
```

**Step 4: Update the update() method to save tags/metadata in version history**

Change the INSERT INTO memory_versions to include tags and metadata:

```javascript
this._run(
  `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [this._generateId(), existing.id, content, newTags, newMeta, newVersion, now]
)
```

Also update the version INSERT in store() similarly:

```javascript
this._run(
  `INSERT INTO memory_versions (id, memory_id, content, tags, metadata, version, created_at)
   VALUES (?, ?, ?, ?, ?, 1, ?)`,
  [this._generateId(), id, content, JSON.stringify(tags), JSON.stringify(metadata), now]
)
```

**Step 5: Verify store creates embeddings**

Run: `cd packages/mcp-server && node -e "
import { MemoryStore } from './src/store.js';
const s = new MemoryStore();
await s._ready;
const r = await s.store('test', 'hello', 'world is great');
console.log('stored:', r);
const row = s._queryOne('SELECT embedding FROM memories WHERE id = ?', [r.id]);
console.log('has embedding:', row.embedding !== null, 'size:', row.embedding?.length);
s.close();
"`
Expected: `has embedding: true size: 1536` (384 floats * 4 bytes)

**Step 6: Commit**

```bash
git add packages/mcp-server/src/store.js
git commit -m "feat: compute and store embeddings on memory store/update"
```

---

### Task 6: Rewrite search to use cosine similarity with TF-IDF fallback

**Files:**
- Modify: `packages/mcp-server/src/store.js:196-229` (search method)

**Step 1: Rewrite the search() method**

Replace the current search method entirely:

```javascript
async search(namespace, query, limit = 10, tags = [], offset = 0) {
  await this._ensureReady()

  // Build base WHERE clause for namespace + tags
  let whereClause = 'WHERE namespace = ?'
  const whereParams = [namespace]
  for (const tag of tags) {
    whereClause += ' AND tags LIKE ?'
    whereParams.push(`%"${tag}"%`)
  }

  // Try embedding-based search first
  if (embeddingsReady()) {
    const queryVec = await embed(query)
    if (queryVec) {
      const rows = this._query(
        `SELECT * FROM memories ${whereClause} AND embedding IS NOT NULL`,
        whereParams
      )

      const scored = rows.map(row => ({
        ...this._formatRow(row),
        score: cosineSimilarity(queryVec, bufferToVector(row.embedding)),
      }))

      scored.sort((a, b) => b.score - a.score)
      const results = scored.slice(offset, offset + limit)

      const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
      this._logUsage('search', namespace, tokensSaved)
      return results
    }
  }

  // Fallback: TF-IDF term matching
  const queryTokens = this._tokenize(query)
  if (queryTokens.length === 0) {
    const rows = this._query(
      `SELECT * FROM memories ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset]
    )
    return rows.map(this._formatRow)
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
  const params = [...queryTokens, namespace, ...tags.map(t => `%"${t}"%`), limit, offset]
  const rows = this._query(sql, params)
  const results = rows.map(this._formatRow)

  const tokensSaved = results.reduce((sum, r) => sum + this._estimateTokens(r.content), 0)
  this._logUsage('search', namespace, tokensSaved)
  return results
}
```

Note: The TF-IDF fallback now uses `SUM(si.tf)` instead of `COUNT(si.term)` — this actually uses the stored TF values.

**Step 2: Update search tool definition in index.js to add offset parameter**

In `index.js`, add `offset` to the `memory_search` inputSchema properties:

```javascript
offset: {
  type: 'number',
  description: 'Number of results to skip for pagination (default: 0)',
},
```

And update the tool handler to pass offset:

```javascript
case 'memory_search': {
  const results = await store.search(
    args.namespace,
    args.query,
    args.limit || 10,
    args.tags || [],
    args.offset || 0
  )
```

**Step 3: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: semantic search via embeddings with TF-IDF fallback"
```

---

### Task 7: Add pagination to memory_list

**Files:**
- Modify: `packages/mcp-server/src/store.js:319-338` (list method)
- Modify: `packages/mcp-server/src/index.js:148-167` (memory_list tool def + handler)

**Step 1: Update list() in store.js to accept limit and offset**

```javascript
async list(namespace, prefix, tags = [], limit = 50, offset = 0) {
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

  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = this._query(sql, params)
  return rows.map(this._formatRow)
}
```

**Step 2: Update memory_list tool definition in index.js**

Add `limit` and `offset` to inputSchema properties:

```javascript
limit: {
  type: 'number',
  description: 'Maximum number of results (default: 50)',
},
offset: {
  type: 'number',
  description: 'Number of results to skip for pagination (default: 0)',
},
```

Update the handler:

```javascript
case 'memory_list': {
  const memories = await store.list(
    args.namespace,
    args.prefix,
    args.tags || [],
    args.limit || 50,
    args.offset || 0
  )
```

**Step 3: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: add pagination (limit/offset) to memory_list"
```

---

### Task 8: Fix version history to return tags/metadata in recall

**Files:**
- Modify: `packages/mcp-server/src/store.js:231-259` (recall method)

**Step 1: Update recall() to return version tags/metadata**

When fetching a specific version, merge the version's tags/metadata into the response:

```javascript
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
      const result = this._formatRow(memory)
      result.content = versionRow.content
      result.version = versionRow.version
      if (versionRow.tags) result.tags = JSON.parse(versionRow.tags)
      if (versionRow.metadata) result.metadata = JSON.parse(versionRow.metadata)
      this._logUsage('recall', namespace, this._estimateTokens(result.content))
      return result
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
```

**Step 2: Commit**

```bash
git add packages/mcp-server/src/store.js
git commit -m "fix: return tags/metadata from version history in recall"
```

---

### Task 9: Add memory_namespaces tool

**Files:**
- Modify: `packages/mcp-server/src/index.js` (add tool definition + handler)

**Step 1: Add tool definition to the tools array**

```javascript
{
  name: 'memory_namespaces',
  description:
    'List all namespaces with their memory counts. Use this to see what memory collections exist.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
},
```

**Step 2: Add handler in the switch statement**

```javascript
case 'memory_namespaces': {
  const namespaces = await store.listNamespaces()
  if (namespaces.length === 0) {
    return {
      content: [{ type: 'text', text: 'No namespaces found. Store a memory to create one.' }],
    }
  }
  const list = namespaces
    .map((ns) => `- ${ns.namespace} (${ns.count} memories)`)
    .join('\n')
  return {
    content: [{ type: 'text', text: `${namespaces.length} namespaces:\n\n${list}` }],
  }
}
```

**Step 3: Commit**

```bash
git add packages/mcp-server/src/index.js
git commit -m "feat: add memory_namespaces tool"
```

---

### Task 10: Add memory_delete_namespace tool

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add deleteNamespace method)
- Modify: `packages/mcp-server/src/index.js` (add tool definition + handler)

**Step 1: Add deleteNamespace() to MemoryStore**

```javascript
async deleteNamespace(namespace, confirm = false) {
  await this._ensureReady()

  if (!confirm) {
    const count = this._queryOne(
      'SELECT COUNT(*) as count FROM memories WHERE namespace = ?',
      [namespace]
    )
    return { confirmed: false, count: count?.count || 0 }
  }

  const memories = this._query(
    'SELECT id FROM memories WHERE namespace = ?',
    [namespace]
  )

  for (const m of memories) {
    this._run('DELETE FROM search_index WHERE memory_id = ?', [m.id])
    this._run('DELETE FROM memory_versions WHERE memory_id = ?', [m.id])
  }
  this._run('DELETE FROM memories WHERE namespace = ?', [namespace])
  this._persist()

  return { confirmed: true, deleted: memories.length }
}
```

**Step 2: Add tool definition**

```javascript
{
  name: 'memory_delete_namespace',
  description:
    'Delete an entire namespace and all its memories permanently. Requires confirm: true to execute.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to delete' },
      confirm: {
        type: 'boolean',
        description: 'Must be true to actually delete. If false/omitted, returns count of memories that would be deleted.',
      },
    },
    required: ['namespace'],
  },
},
```

**Step 3: Add handler**

```javascript
case 'memory_delete_namespace': {
  const result = await store.deleteNamespace(args.namespace, args.confirm || false)
  if (!result.confirmed) {
    return {
      content: [{
        type: 'text',
        text: `Namespace "${args.namespace}" has ${result.count} memories. Set confirm: true to delete them all permanently.`,
      }],
    }
  }
  return {
    content: [{
      type: 'text',
      text: `Deleted namespace "${args.namespace}" and ${result.deleted} memories.`,
    }],
  }
}
```

**Step 4: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: add memory_delete_namespace tool"
```

---

### Task 11: Add memory_export tool

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add exportNamespace method)
- Modify: `packages/mcp-server/src/index.js` (add tool definition + handler)

**Step 1: Add exportNamespace() to MemoryStore**

```javascript
async exportNamespace(namespace) {
  await this._ensureReady()

  let sql = 'SELECT * FROM memories'
  const params = []

  if (namespace) {
    sql += ' WHERE namespace = ?'
    params.push(namespace)
  }

  sql += ' ORDER BY namespace, key'
  const memories = this._query(sql, params)

  const exported = memories.map(row => {
    const formatted = this._formatRow(row)

    // Get version history
    const versions = this._query(
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
```

**Step 2: Add tool definition**

```javascript
{
  name: 'memory_export',
  description:
    'Export memories as JSON for backup or migration. Exports a single namespace, or all namespaces if omitted. Includes full version history.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace to export. Omit to export all namespaces.',
      },
    },
  },
},
```

**Step 3: Add handler**

```javascript
case 'memory_export': {
  const data = await store.exportNamespace(args.namespace)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(data, null, 2),
    }],
  }
}
```

**Step 4: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: add memory_export tool"
```

---

### Task 12: Add memory_import tool

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add importMemories method)
- Modify: `packages/mcp-server/src/index.js` (add tool definition + handler)

**Step 1: Add importMemories() to MemoryStore**

```javascript
async importMemories(data, onConflict = 'skip') {
  await this._ensureReady()

  if (data.export_version !== 1) {
    throw new Error(`Unsupported export version: ${data.export_version}`)
  }

  let imported = 0
  let skipped = 0
  let overwritten = 0

  for (const memory of data.memories) {
    const existing = this._queryOne(
      'SELECT id FROM memories WHERE namespace = ? AND key = ?',
      [memory.namespace, memory.key]
    )

    if (existing) {
      if (onConflict === 'skip') {
        skipped++
        continue
      }
      // overwrite: delete existing first
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
```

**Step 2: Add tool definition**

```javascript
{
  name: 'memory_import',
  description:
    'Import memories from a JSON export. Handles conflicts with skip (default) or overwrite mode.',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description: 'The JSON export data (from memory_export output)',
      },
      on_conflict: {
        type: 'string',
        enum: ['skip', 'overwrite'],
        description: 'How to handle existing keys: skip (default) or overwrite',
      },
    },
    required: ['data'],
  },
},
```

**Step 3: Add handler**

```javascript
case 'memory_import': {
  const result = await store.importMemories(args.data, args.on_conflict || 'skip')
  return {
    content: [{
      type: 'text',
      text: `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.overwritten} overwritten.`,
    }],
  }
}
```

**Step 4: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: add memory_import tool"
```

---

### Task 13: Add memory_summarize tool

**Files:**
- Modify: `packages/mcp-server/src/store.js` (add summarize method)
- Modify: `packages/mcp-server/src/index.js` (add tool definition + handler)

**Step 1: Add summarize() to MemoryStore**

This is a pure data aggregation — the calling agent (Claude) does the actual summarization.

```javascript
async summarize(namespace) {
  await this._ensureReady()

  const total = this._queryOne(
    'SELECT COUNT(*) as count FROM memories WHERE namespace = ?',
    [namespace]
  )

  if (!total || total.count === 0) {
    return null
  }

  // All keys with their tags
  const memories = this._query(
    'SELECT key, tags, version, updated_at, LENGTH(content) as content_length FROM memories WHERE namespace = ? ORDER BY updated_at DESC',
    [namespace]
  )

  // Group by tags
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

  // Recent updates (top 5)
  const recent = memories.slice(0, 5)

  // Total tokens stored
  const tokenTotal = this._queryOne(
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
```

**Step 2: Add tool definition**

```javascript
{
  name: 'memory_summarize',
  description:
    'Get a condensed overview of a namespace: total memories, keys grouped by tag, recent updates, and token usage. Useful for understanding what knowledge is stored without reading every memory.',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: 'Namespace to summarize' },
    },
    required: ['namespace'],
  },
},
```

**Step 3: Add handler**

```javascript
case 'memory_summarize': {
  const summary = await store.summarize(args.namespace)
  if (!summary) {
    return {
      content: [{ type: 'text', text: `Namespace "${args.namespace}" is empty or does not exist.` }],
    }
  }

  let text = `Namespace "${summary.namespace}" — ${summary.total_memories} memories, ~${summary.total_tokens.toLocaleString()} tokens\n\n`

  if (Object.keys(summary.by_tag).length > 0) {
    text += `By tag:\n`
    for (const [tag, keys] of Object.entries(summary.by_tag)) {
      text += `  [${tag}]: ${keys.join(', ')}\n`
    }
  }
  if (summary.untagged.length > 0) {
    text += `  [untagged]: ${summary.untagged.join(', ')}\n`
  }

  text += `\nRecent updates:\n`
  for (const r of summary.recent_updates) {
    text += `  - ${r.key} (v${r.version}, ${r.content_length} chars, ${r.updated_at})\n`
  }

  return { content: [{ type: 'text', text }] }
}
```

**Step 4: Commit**

```bash
git add packages/mcp-server/src/store.js packages/mcp-server/src/index.js
git commit -m "feat: add memory_summarize tool"
```

---

### Task 14: Update server metadata and cleanup

**Files:**
- Modify: `packages/mcp-server/src/index.js:1-11` (header comment)
- Modify: `packages/mcp-server/src/store.js:1-9` (header comment)
- Modify: `packages/mcp-server/package.json` (bump version)

**Step 1: Clean up store.js header — remove cloud API reference**

Replace lines 1-9 of store.js:

```javascript
/**
 * AgentMemory Store
 *
 * Local storage engine using sql.js (SQLite compiled to WASM)
 * with semantic vector search via Transformers.js and TF-IDF fallback.
 */
```

**Step 2: Update index.js server version**

```javascript
const server = new Server(
  { name: 'agentmemory', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {} } }
)
```

**Step 3: Bump package.json version to 0.2.0**

```json
"version": "0.2.0"
```

**Step 4: Add graceful shutdown handler to index.js**

At the end of the `main()` function, after `server.connect`:

```javascript
process.on('SIGINT', () => { store.close(); process.exit(0) })
process.on('SIGTERM', () => { store.close(); process.exit(0) })
```

**Step 5: Commit**

```bash
git add packages/mcp-server/
git commit -m "chore: update metadata, bump to v0.2.0, add graceful shutdown"
```

---

### Task 15: Write README

**Files:**
- Create or overwrite: `README.md` (root)

**Step 1: Write the README**

```markdown
# AgentMemory

Persistent, searchable memory for AI agents. Runs locally as an MCP server — no cloud, no API keys, no setup.

## Features

- **Semantic search** — finds relevant memories even when wording differs (powered by Transformers.js)
- **Version history** — every update preserves the previous version
- **Namespaces** — organize memories by project, topic, or agent
- **Export/import** — back up and migrate memories as JSON
- **Zero config** — `npx @agentmemory/mcp-server` and you're running

## Setup

Add to your Claude Code settings (`~/.claude/settings.json`):

\```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"]
    }
  }
}
\```

### Per-project isolation

To keep memories separate per project, set `AGENTMEMORY_DB_PATH`:

\```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"],
      "env": { "AGENTMEMORY_DB_PATH": "./.agentmemory" }
    }
  }
}
\```

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory with key, content, tags, metadata |
| `memory_search` | Semantic search across memories |
| `memory_recall` | Fetch a specific memory by key |
| `memory_update` | Update a memory (preserves version history) |
| `memory_forget` | Permanently delete a memory |
| `memory_list` | List memories with pagination and filters |
| `memory_stats` | Token usage statistics |
| `memory_namespaces` | List all namespaces |
| `memory_delete_namespace` | Delete a namespace and all its memories |
| `memory_export` | Export memories as JSON |
| `memory_import` | Import memories from JSON |
| `memory_summarize` | Overview of a namespace's contents |

## Storage

Memories are stored in a local SQLite database at `~/.agentmemory/memories.db`. The embedding model (`all-MiniLM-L6-v2`, ~23MB) downloads automatically on first use.

## License

MIT
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README for MCP-only AgentMemory"
```

---

### Task 16: End-to-end smoke test

**Step 1: Delete the test database to start fresh**

```bash
rm -f ~/.agentmemory/memories.db
```

**Step 2: Start the server and test via MCP inspector or direct node test**

```bash
cd packages/mcp-server
node -e "
import { MemoryStore } from './src/store.js';
const s = new MemoryStore();
await s._ready;

// Store
const r1 = await s.store('test', 'api-design', 'We chose REST over GraphQL for simplicity', ['architecture', 'decision']);
console.log('1. Store:', r1.key, 'v' + r1.version);

// Search (semantic — should find even with different wording)
const r2 = await s.search('test', 'what API style did we pick');
console.log('2. Search:', r2.length, 'results, top:', r2[0]?.key);

// Update
const r3 = await s.update('test', 'api-design', 'We chose REST over GraphQL. Added versioning with /v1/ prefix.', ['architecture', 'decision', 'api']);
console.log('3. Update:', r3.key, 'v' + r3.version);

// Recall specific version
const r4 = await s.recall('test', 'api-design', 1);
console.log('4. Recall v1:', r4.content.substring(0, 40));

// Namespaces
const r5 = await s.listNamespaces();
console.log('5. Namespaces:', r5);

// Summarize
const r6 = await s.summarize('test');
console.log('6. Summary:', r6.total_memories, 'memories');

// Export
const r7 = await s.exportNamespace('test');
console.log('7. Export:', r7.count, 'memories exported');

// Import (skip conflicts)
const r8 = await s.importMemories(r7, 'skip');
console.log('8. Import:', r8);

// Delete namespace
const r9 = await s.deleteNamespace('test', true);
console.log('9. Delete namespace:', r9);

// Verify empty
const r10 = await s.listNamespaces();
console.log('10. Namespaces after delete:', r10);

s.close();
console.log('All tests passed!');
"
```

Expected: All 10 steps print successfully. Search finds the memory even though query wording differs.

**Step 3: Commit (no code changes — just verifying)**

No commit needed for this task.
