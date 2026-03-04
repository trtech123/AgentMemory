#!/usr/bin/env node

/**
 * AgentMemory MCP Server
 *
 * Provides persistent, searchable memory for AI agents via MCP.
 * Works standalone with local SQLite storage, or connects to AgentMemory cloud.
 *
 * Usage in Claude Code settings.json:
 *   { "mcpServers": { "agentmemory": { "command": "npx", "args": ["@agentmemory/mcp-server"] } } }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { MemoryStore } from './store.js'

const store = new MemoryStore(process.env.AGENTMEMORY_DB_PATH)

const server = new Server(
  { name: 'agentmemory', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
)

// ─── Tool Definitions ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_store',
      description:
        'Store a new memory. Use this to save important information, decisions, patterns, or learnings that should persist across sessions. Memories are stored in namespaces (like folders) with unique keys.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'Namespace to organize memories (e.g., "project-x", "user-prefs", "debug-notes")',
          },
          key: {
            type: 'string',
            description: 'Unique key for this memory within the namespace (e.g., "auth-architecture", "db-schema")',
          },
          content: {
            type: 'string',
            description: 'The memory content to store. Can be any text — notes, code snippets, decisions, etc.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for categorization and filtering (e.g., ["architecture", "decision"])',
          },
          metadata: {
            type: 'object',
            description: 'Optional structured metadata (e.g., {"priority": "high", "source": "code-review"})',
          },
        },
        required: ['namespace', 'key', 'content'],
      },
    },
    {
      name: 'memory_search',
      description:
        'Search memories by natural language query. Returns the most relevant memories ranked by relevance. Use this to recall past decisions, patterns, or context.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'Namespace to search in',
          },
          query: {
            type: 'string',
            description: 'Natural language search query (e.g., "authentication approach", "database migration issues")',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter results to only memories with these tags',
          },
          offset: {
            type: 'number',
            description: 'Number of results to skip for pagination (default: 0)',
          },
        },
        required: ['namespace', 'query'],
      },
    },
    {
      name: 'memory_recall',
      description:
        'Recall a specific memory by its exact key. Optionally retrieve a specific version. Use this when you know exactly which memory you need.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace of the memory' },
          key: { type: 'string', description: 'Exact key of the memory to recall' },
          version: {
            type: 'number',
            description: 'Specific version to recall (omit for latest)',
          },
        },
        required: ['namespace', 'key'],
      },
    },
    {
      name: 'memory_update',
      description:
        'Update an existing memory. Creates a new version (old versions are preserved). Use this when information changes or needs correction.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace of the memory' },
          key: { type: 'string', description: 'Key of the memory to update' },
          content: { type: 'string', description: 'Updated content' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Updated tags (replaces existing tags)',
          },
          metadata: {
            type: 'object',
            description: 'Metadata to merge into existing metadata',
          },
        },
        required: ['namespace', 'key', 'content'],
      },
    },
    {
      name: 'memory_forget',
      description:
        'Delete a memory permanently. Use with caution — this removes the memory and all its versions.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace of the memory' },
          key: { type: 'string', description: 'Key of the memory to delete' },
        },
        required: ['namespace', 'key'],
      },
    },
    {
      name: 'memory_list',
      description:
        'List memories in a namespace. Optionally filter by key prefix and tags. Returns memories sorted by most recently updated.',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Namespace to list memories from' },
          prefix: {
            type: 'string',
            description: 'Filter to keys starting with this prefix',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter to memories with these tags',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 50)',
          },
          offset: {
            type: 'number',
            description: 'Number of results to skip for pagination (default: 0)',
          },
        },
        required: ['namespace'],
      },
    },
    {
      name: 'memory_stats',
      description:
        'Get token usage statistics. Shows total tokens stored in memories and total tokens saved by recalling/searching instead of regenerating. Use this to understand memory efficiency.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'memory_namespaces',
      description:
        'List all namespaces with their memory counts. Use this to see what memory collections exist.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
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
  ],
}))

// ─── Tool Execution ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'memory_store': {
        const result = await store.store(
          args.namespace,
          args.key,
          args.content,
          args.tags || [],
          args.metadata || {}
        )
        return {
          content: [
            {
              type: 'text',
              text: `Stored memory "${args.key}" in namespace "${args.namespace}" (version ${result.version}, ${result.tokens} tokens)`,
            },
          ],
        }
      }

      case 'memory_search': {
        const results = await store.search(
          args.namespace,
          args.query,
          args.limit || 10,
          args.tags || [],
          args.offset || 0
        )
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No memories found matching "${args.query}" in "${args.namespace}"` }],
          }
        }
        const formatted = results
          .map(
            (m, i) =>
              `${i + 1}. [${m.key}] (v${m.version}, tags: ${m.tags.join(', ') || 'none'})\n   ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`
          )
          .join('\n\n')
        const tokensSaved = results.reduce((sum, r) => sum + Math.ceil(r.content.length / 4), 0)
        return {
          content: [
            { type: 'text', text: `Found ${results.length} memories (${tokensSaved} tokens saved):\n\n${formatted}` },
          ],
        }
      }

      case 'memory_recall': {
        const memory = await store.recall(args.namespace, args.key, args.version)
        if (!memory) {
          return {
            content: [
              { type: 'text', text: `Memory "${args.key}" not found in namespace "${args.namespace}"` },
            ],
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: `Key: ${memory.key}\nNamespace: ${memory.namespace}\nVersion: ${memory.version}\nTags: ${memory.tags.join(', ') || 'none'}\nUpdated: ${memory.updated_at}\n\n${memory.content}`,
            },
          ],
        }
      }

      case 'memory_update': {
        const result = await store.update(
          args.namespace,
          args.key,
          args.content,
          args.tags,
          args.metadata
        )
        return {
          content: [
            {
              type: 'text',
              text: `Updated memory "${args.key}" in "${args.namespace}" (now version ${result.version})`,
            },
          ],
        }
      }

      case 'memory_forget': {
        const deleted = await store.forget(args.namespace, args.key)
        return {
          content: [
            {
              type: 'text',
              text: deleted
                ? `Deleted memory "${args.key}" from "${args.namespace}"`
                : `Memory "${args.key}" not found in "${args.namespace}"`,
            },
          ],
        }
      }

      case 'memory_list': {
        const memories = await store.list(
          args.namespace,
          args.prefix,
          args.tags || [],
          args.limit || 50,
          args.offset || 0
        )
        if (memories.length === 0) {
          return {
            content: [{ type: 'text', text: `No memories in namespace "${args.namespace}"` }],
          }
        }
        const list = memories
          .map(
            (m) =>
              `- ${m.key} (v${m.version}, ${m.tags.length} tags, updated ${m.updated_at})`
          )
          .join('\n')
        return {
          content: [
            { type: 'text', text: `${memories.length} memories in "${args.namespace}":\n\n${list}` },
          ],
        }
      }

      case 'memory_stats': {
        const stats = await store.getStats()
        const saved = stats.total_tokens_saved
        const costSaved = {
          opus: (saved / 1_000_000 * 75).toFixed(2),
          sonnet: (saved / 1_000_000 * 15).toFixed(2),
          gpt4o: (saved / 1_000_000 * 10).toFixed(2),
        }
        const ratio = stats.total_tokens_stored > 0
          ? (saved / stats.total_tokens_stored).toFixed(1)
          : '0.0'
        return {
          content: [
            {
              type: 'text',
              text: `Token Stats:\n- Tokens stored: ${stats.total_tokens_stored.toLocaleString()}\n- Tokens saved by recall/search: ${saved.toLocaleString()}\n- ROI ratio: ${ratio}x (tokens saved per token stored)\n- Total memories: ${stats.total_memories}\n- Total namespaces: ${stats.total_namespaces}\n\nEstimated cost saved (based on output token pricing):\n- Claude Opus 4: $${costSaved.opus}\n- Claude Sonnet 4: $${costSaved.sonnet}\n- GPT-4o: $${costSaved.gpt4o}`,
            },
          ],
        }
      }

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

      case 'memory_export': {
        const data = await store.exportNamespace(args.namespace)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(data, null, 2),
          }],
        }
      }

      case 'memory_import': {
        const result = await store.importMemories(args.data, args.on_conflict || 'skip')
        return {
          content: [{
            type: 'text',
            text: `Import complete: ${result.imported} imported, ${result.skipped} skipped, ${result.overwritten} overwritten.`,
          }],
        }
      }

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

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    }
  }
})

// ─── Resources ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const namespaces = await store.listNamespaces()
  return {
    resources: [
      {
        uri: 'memory://namespaces',
        name: 'All Namespaces',
        description: 'List all memory namespaces and their sizes',
        mimeType: 'application/json',
      },
      ...namespaces.map((ns) => ({
        uri: `memory://namespace/${ns.namespace}`,
        name: `Namespace: ${ns.namespace}`,
        description: `${ns.count} memories`,
        mimeType: 'application/json',
      })),
    ],
  }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params

  if (uri === 'memory://namespaces') {
    const namespaces = await store.listNamespaces()
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(namespaces, null, 2),
        },
      ],
    }
  }

  const nsMatch = uri.match(/^memory:\/\/namespace\/(.+)$/)
  if (nsMatch) {
    const memories = await store.list(nsMatch[1])
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(memories, null, 2),
        },
      ],
    }
  }

  return { contents: [] }
})

// ─── Start Server ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('AgentMemory MCP server running on stdio')
}

main().catch((error) => {
  console.error('Failed to start AgentMemory MCP server:', error)
  process.exit(1)
})
