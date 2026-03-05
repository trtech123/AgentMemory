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

Memories are stored in a local SQLite database at `~/.agentmemory/memories.db` using better-sqlite3 with the [sqlite-vec](https://github.com/asg017/sqlite-vec) extension for fast KNN vector search. The embedding model (`all-MiniLM-L6-v2`, ~23MB) downloads automatically on first use.

## License

MIT
