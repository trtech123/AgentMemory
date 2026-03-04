# AgentMemory MCP Redesign

**Date:** 2026-03-05
**Status:** Approved

## Summary

Redesign AgentMemory from a multi-package product (API server + SDKs + MCP server + docs site) into a single MCP-only, local-only tool for Claude Code users. Delete all cloud infrastructure. Add semantic search via Transformers.js, namespace management, export/import, and summarize.

## Decisions

- **Target user:** Claude Code users
- **Architecture:** MCP-only, local-only, stdio transport
- **Search:** Transformers.js (`all-MiniLM-L6-v2`, 384-dim) with TF-IDF fallback
- **Storage:** Global `~/.agentmemory/memories.db` by default, per-project via `AGENTMEMORY_DB_PATH` env var
- **Approach:** Enhance in-place (no rewrite, no TypeScript)
- **Cleanup:** Delete packages/api, packages/sdk-ts, packages/sdk-py, packages/docs

## Architecture

3 source files:

```
packages/mcp-server/src/
├── index.js        — MCP server, tool definitions, transport
├── store.js        — SQLite CRUD, search, TF-IDF fallback
└── embeddings.js   — Transformers.js wrapper, model loading, cosine similarity
```

Dependencies (3):
- `@modelcontextprotocol/sdk`
- `sql.js`
- `@huggingface/transformers`

Search flow:
1. On first `memory_store`, embeddings.js lazy-loads `all-MiniLM-L6-v2`
2. Content embedded to 384-dim float vector, stored as BLOB
3. On `memory_search`, query embedded, cosine similarity against stored vectors
4. If model not loaded yet, falls back to fixed TF-IDF

## MCP Tools (12 total)

### Existing (7, reworked)

| Tool | Changes |
|---|---|
| `memory_store` | Computes embedding vector. Stores as BLOB. TF-IDF index kept as fallback. |
| `memory_search` | Cosine similarity on embeddings. TF-IDF fallback. Adds `offset` for pagination. |
| `memory_recall` | Returns tags/metadata from version history. |
| `memory_update` | Version snapshots now include tags + metadata. Re-embeds on update. |
| `memory_forget` | No changes. |
| `memory_list` | Adds `limit` + `offset` for pagination. Default limit 50. |
| `memory_stats` | No changes. |

### New (5)

| Tool | Purpose |
|---|---|
| `memory_export` | Export namespace(s) as JSON (keys, content, tags, metadata, versions). |
| `memory_import` | Import from JSON export. `skip` or `overwrite` conflict handling. |
| `memory_namespaces` | List all namespaces with memory counts. |
| `memory_delete_namespace` | Delete namespace + all memories. Requires `confirm: true`. |
| `memory_summarize` | Condensed namespace view: total memories, keys grouped by tags, recent updates. |

### Resources (2, kept)

- `memory://namespaces`
- `memory://namespace/{name}`

## Database Schema

### memories table (updated)

```sql
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT DEFAULT '[]',
  metadata   TEXT DEFAULT '{}',
  embedding  BLOB,                  -- 384-dim float32 binary
  version    INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
)
```

### memory_versions table (expanded)

```sql
CREATE TABLE memory_versions (
  id         TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT,                   -- snapshot of tags at this version
  metadata   TEXT,                   -- snapshot of metadata at this version
  version    INTEGER NOT NULL,
  created_at TEXT NOT NULL
)
```

### search_index + usage_log — kept as-is

### Migration

On startup, check for new columns. `ALTER TABLE` to add if missing. Existing DBs upgrade seamlessly.
