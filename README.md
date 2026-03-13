# AgentMemory

Persistent, searchable memory for AI agents. Runs locally as an MCP server — no cloud, no API keys, no native dependencies.

## Features

- **Semantic search** — finds relevant memories even when wording differs (powered by Transformers.js `all-MiniLM-L6-v2`)
- **TF-IDF fallback** — works immediately without downloading the embedding model
- **Version history** — every update preserves the previous version (up to 20 versions per memory)
- **Namespaces** — organize memories by project, topic, or agent
- **Export/import** — back up and migrate memories as JSON
- **Atomic writes** — crash-safe three-step rename with automatic recovery
- **Zero config** — `npx @agentmemory/mcp-server` and you're running

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"]
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"]
    }
  }
}
```

### Per-project isolation

To keep memories separate per project, set `AGENTMEMORY_DB_PATH`:

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"],
      "env": { "AGENTMEMORY_DB_PATH": "./.agentmemory" }
    }
  }
}
```

## Tools

15 MCP tools are available:

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory with key, content, tags, metadata |
| `memory_search` | Semantic search across memories |
| `memory_recall` | Fetch a specific memory by key (optionally a prior version) |
| `memory_update` | Update a memory (preserves version history) |
| `memory_forget` | Permanently delete a memory |
| `memory_list` | List memories with prefix filter, tags, and pagination |
| `memory_stats` | Token usage statistics and estimated cost saved |
| `memory_namespaces` | List all namespaces with memory counts |
| `memory_delete_namespace` | Delete a namespace and all its memories |
| `memory_export` | Export memories as JSON for backup or migration |
| `memory_import` | Import memories from a JSON export |
| `memory_summarize` | Overview of a namespace's contents grouped by tag |
| `memory_compress` | Compress text using extractive summarization (nothing stored) |
| `memory_snapshot` | Store a session context snapshot, auto-tagged `session-snapshot` |
| `memory_bulk_recall` | Recall multiple memories and return a merged compressed summary |

## Storage

Memories are stored in a local SQLite database at `~/.agentmemory/memories.db`. The storage engine uses **sql.js** (WASM SQLite — no native build tools required). Embeddings are stored as binary BLOBs (~33% smaller than JSON text).

The embedding model (`all-MiniLM-L6-v2`, ~23MB) downloads automatically on first use via Transformers.js. If the model is unavailable, AgentMemory falls back to TF-IDF term matching automatically.

### Limits

| Limit | Value |
|-------|-------|
| Max content size | 100,000 characters |
| Max tags per memory | 50 |
| Max tag length | 100 characters |
| Max metadata size | 10KB (serialized) |
| Max versions per memory | 20 |
| Usage log retention | 90 days |

## v0.3.0 → v0.4.0 Migration

v0.4.0 stores embeddings as binary BLOBs instead of JSON text. Existing v0.3.0 databases are **incompatible** — the server will refuse to start if it detects a v0.3.0 database.

To migrate:

1. With v0.3.0 still installed, export your data:
   ```
   # Ask Claude to run: memory_export (no namespace argument = all namespaces)
   # Save the JSON output to a file
   ```

2. Upgrade the package:
   ```
   npm install -g @agentmemory/mcp-server@0.4.0
   ```

3. Delete (or rename) the old database:
   ```
   mv ~/.agentmemory/memories.db ~/.agentmemory/memories.db.v030.bak
   ```

4. Restart your MCP client, then import:
   ```
   # Ask Claude to run: memory_import with the JSON data you saved
   ```

## Debugging

Set `DEBUG=agentmemory` to enable verbose logging to stderr:

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["@agentmemory/mcp-server"],
      "env": { "DEBUG": "agentmemory" }
    }
  }
}
```

This logs persist events, dirty-flag scheduling, crash recovery steps, and embedding model load status.

## License

MIT
