import { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import db, { PLAN_LIMITS, type Plan } from "../db.js";
import { authenticate, canAccessNamespace, hasPermission } from "../lib/auth.js";
import {
  textToVector,
  serializeVector,
  semanticSearch,
} from "../lib/vectors.js";

const storeSchema = z.object({
  namespace: z.string().optional(), // namespace name or ID; defaults to "default"
  key: z.string().max(255).optional(), // optional unique key for recall
  content: z.string().min(1).max(100000),
  metadata: z.record(z.any()).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  expires_in_seconds: z.number().positive().optional(),
});

const searchSchema = z.object({
  namespace: z.string().optional(),
  query: z.string().min(1).max(5000),
  top_k: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.05),
  tags: z.array(z.string()).optional(), // filter by tags
  metadata_filter: z.record(z.any()).optional(),
});

const updateSchema = z.object({
  content: z.string().min(1).max(100000).optional(),
  metadata: z.record(z.any()).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export async function memoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  // --- STORE ---
  app.post("/store", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "write")) {
      return reply.status(403).send({ error: "Write permission required" });
    }

    const body = storeSchema.parse(request.body);

    // Resolve namespace
    const ns = resolveNamespace(auth.accountId, body.namespace);
    if (!ns) return reply.status(404).send({ error: "Namespace not found" });
    if (!canAccessNamespace(auth, ns.id)) {
      return reply.status(403).send({ error: "No access to this namespace" });
    }

    // Check memory limits
    const limits = PLAN_LIMITS[auth.plan as Plan];
    if (limits.memories > 0) {
      const count = db.get(
        `SELECT COUNT(*) as count FROM memories m
         JOIN namespaces n ON m.namespace_id = n.id
         WHERE n.account_id = ?`,
        auth.accountId
      );
      if ((count?.count || 0) >= limits.memories) {
        return reply.status(403).send({
          error: `Plan limited to ${limits.memories} memories. Upgrade for more.`,
          upgrade: true,
        });
      }
    }

    // If key exists, update instead
    if (body.key) {
      const existing = db.get(
        "SELECT id, version FROM memories WHERE namespace_id = ? AND key = ?",
        ns.id, body.key
      );
      if (existing) {
        return await updateMemory(existing.id, body, existing.version, reply);
      }
    }

    // Compute embedding
    const vec = textToVector(body.content);
    const embedding = serializeVector(vec);

    const id = nanoid();
    const expiresAt = body.expires_in_seconds
      ? new Date(Date.now() + body.expires_in_seconds * 1000).toISOString()
      : null;

    db.run(
      `INSERT INTO memories (id, namespace_id, key, content, metadata, tags, embedding, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ns.id, body.key || null, body.content,
      JSON.stringify(body.metadata || {}),
      JSON.stringify(body.tags || []),
      embedding, expiresAt
    );

    const tokensUsed = estimateTokens(body.content);
    logUsage(auth.accountId, "store", ns.id, tokensUsed);

    return {
      memory: {
        id, namespace: ns.name, key: body.key,
        content: body.content, metadata: body.metadata || {},
        tags: body.tags || [], version: 1,
        created_at: new Date().toISOString(),
        tokens: tokensUsed,
      },
    };
  });

  // --- SEARCH (semantic) ---
  app.post("/search", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "read")) {
      return reply.status(403).send({ error: "Read permission required" });
    }

    const body = searchSchema.parse(request.body);

    const ns = body.namespace
      ? resolveNamespace(auth.accountId, body.namespace)
      : null;

    // Get candidate memories
    let memories: any[];
    if (ns) {
      if (!canAccessNamespace(auth, ns.id)) {
        return reply.status(403).send({ error: "No access to this namespace" });
      }
      memories = db.all(
        "SELECT id, content, embedding, metadata, tags, key, namespace_id, version, created_at, updated_at FROM memories WHERE namespace_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
        ns.id
      );
    } else {
      // Search across all accessible namespaces
      if (auth.allowedNamespaces) {
        const placeholders = auth.allowedNamespaces.map(() => "?").join(",");
        memories = db.all(
          `SELECT m.id, m.content, m.embedding, m.metadata, m.tags, m.key, m.namespace_id, m.version, m.created_at, m.updated_at
           FROM memories m JOIN namespaces n ON m.namespace_id = n.id
           WHERE n.account_id = ? AND m.namespace_id IN (${placeholders})
           AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))`,
          auth.accountId, ...auth.allowedNamespaces
        );
      } else {
        memories = db.all(
          `SELECT m.id, m.content, m.embedding, m.metadata, m.tags, m.key, m.namespace_id, m.version, m.created_at, m.updated_at
           FROM memories m JOIN namespaces n ON m.namespace_id = n.id
           WHERE n.account_id = ?
           AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))`,
          auth.accountId
        );
      }
    }

    // Filter by tags
    if (body.tags && body.tags.length > 0) {
      memories = memories.filter((m: any) => {
        const mTags = JSON.parse(m.tags) as string[];
        return body.tags!.some((t) => mTags.includes(t));
      });
    }

    // Filter by metadata
    if (body.metadata_filter) {
      memories = memories.filter((m: any) => {
        const meta = JSON.parse(m.metadata);
        return Object.entries(body.metadata_filter!).every(
          ([k, v]) => meta[k] === v
        );
      });
    }

    // Semantic search
    const results = semanticSearch(
      body.query, memories, body.top_k, body.threshold
    );

    // Build response
    const memMap = new Map(memories.map((m: any) => [m.id, m]));
    const response = results.map((r) => {
      const m = memMap.get(r.id)!;
      const nsInfo = db.get("SELECT name FROM namespaces WHERE id = ?", m.namespace_id);
      return {
        id: m.id,
        score: Math.round(r.score * 10000) / 10000,
        namespace: nsInfo?.name,
        key: m.key,
        content: m.content,
        metadata: JSON.parse(m.metadata),
        tags: JSON.parse(m.tags),
        version: m.version,
        created_at: m.created_at,
        updated_at: m.updated_at,
      };
    });

    const tokensSaved = response.reduce((sum: number, r: any) => sum + estimateTokens(r.content), 0);
    logUsage(auth.accountId, "search", ns?.id, tokensSaved);

    return { results: response, total_searched: memories.length, tokens_saved: tokensSaved };
  });

  // --- RECALL (by key) ---
  app.get("/recall/:key", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "read")) {
      return reply.status(403).send({ error: "Read permission required" });
    }

    const { key } = request.params as any;
    const { namespace } = request.query as any;

    const ns = resolveNamespace(auth.accountId, namespace || "default");
    if (!ns) return reply.status(404).send({ error: "Namespace not found" });
    if (!canAccessNamespace(auth, ns.id)) {
      return reply.status(403).send({ error: "No access to this namespace" });
    }

    const memory = db.get(
      "SELECT * FROM memories WHERE namespace_id = ? AND key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
      ns.id, key
    );
    if (!memory) return reply.status(404).send({ error: "Memory not found" });

    const tokensSaved = estimateTokens(memory.content);
    logUsage(auth.accountId, "recall", ns.id, tokensSaved);

    return {
      memory: {
        id: memory.id, namespace: ns.name, key: memory.key,
        content: memory.content, metadata: JSON.parse(memory.metadata),
        tags: JSON.parse(memory.tags), version: memory.version,
        created_at: memory.created_at, updated_at: memory.updated_at,
        tokens: tokensSaved,
      },
    };
  });

  // --- UPDATE (by ID) ---
  app.put("/update/:memoryId", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "write")) {
      return reply.status(403).send({ error: "Write permission required" });
    }

    const { memoryId } = request.params as any;
    const body = updateSchema.parse(request.body);

    const memory = db.get("SELECT * FROM memories WHERE id = ?", memoryId);
    if (!memory) return reply.status(404).send({ error: "Memory not found" });

    // Verify ownership
    const ns = db.get(
      "SELECT * FROM namespaces WHERE id = ? AND account_id = ?",
      memory.namespace_id, auth.accountId
    );
    if (!ns) return reply.status(404).send({ error: "Memory not found" });
    if (!canAccessNamespace(auth, ns.id)) {
      return reply.status(403).send({ error: "No access to this namespace" });
    }

    return await updateMemory(memoryId, body, memory.version, reply);
  });

  // --- FORGET (delete) ---
  app.delete("/forget/:memoryId", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "write")) {
      return reply.status(403).send({ error: "Write permission required" });
    }

    const { memoryId } = request.params as any;

    const memory = db.get("SELECT * FROM memories WHERE id = ?", memoryId);
    if (!memory) return reply.status(404).send({ error: "Memory not found" });

    const ns = db.get(
      "SELECT * FROM namespaces WHERE id = ? AND account_id = ?",
      memory.namespace_id, auth.accountId
    );
    if (!ns) return reply.status(404).send({ error: "Memory not found" });

    db.run("DELETE FROM memory_versions WHERE memory_id = ?", memoryId);
    db.run("DELETE FROM memories WHERE id = ?", memoryId);

    logUsage(auth.accountId, "forget", ns.id);

    return { success: true, forgotten: memoryId };
  });

  // --- LIST memories in namespace ---
  app.get("/list", async (request, reply) => {
    const auth = (request as any).auth;
    if (!hasPermission(auth, "read")) {
      return reply.status(403).send({ error: "Read permission required" });
    }

    const { namespace, page = "1", limit = "50", tag } = request.query as any;

    const ns = resolveNamespace(auth.accountId, namespace || "default");
    if (!ns) return reply.status(404).send({ error: "Namespace not found" });
    if (!canAccessNamespace(auth, ns.id)) {
      return reply.status(403).send({ error: "No access to this namespace" });
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let memories = db.all(
      "SELECT id, key, content, metadata, tags, version, created_at, updated_at FROM memories WHERE namespace_id = ? AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      ns.id, parseInt(limit), offset
    );

    if (tag) {
      memories = memories.filter((m: any) => {
        const tags = JSON.parse(m.tags);
        return tags.includes(tag);
      });
    }

    const total = db.get(
      "SELECT COUNT(*) as count FROM memories WHERE namespace_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))",
      ns.id
    );

    return {
      memories: memories.map((m: any) => ({
        ...m,
        namespace: ns.name,
        metadata: JSON.parse(m.metadata),
        tags: JSON.parse(m.tags),
      })),
      total: total?.count || 0,
      page: parseInt(page),
    };
  });

  // --- VERSION HISTORY ---
  app.get("/history/:memoryId", async (request, reply) => {
    const auth = (request as any).auth;
    const { memoryId } = request.params as any;

    const memory = db.get("SELECT * FROM memories WHERE id = ?", memoryId);
    if (!memory) return reply.status(404).send({ error: "Memory not found" });

    const ns = db.get(
      "SELECT * FROM namespaces WHERE id = ? AND account_id = ?",
      memory.namespace_id, auth.accountId
    );
    if (!ns) return reply.status(404).send({ error: "Memory not found" });

    const versions = db.all(
      "SELECT id, version, content, metadata, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version DESC",
      memoryId
    );

    return {
      current_version: memory.version,
      versions: versions.map((v: any) => ({
        ...v, metadata: JSON.parse(v.metadata),
      })),
    };
  });
}

// --- Helpers ---

function resolveNamespace(accountId: string, nameOrId?: string) {
  if (!nameOrId || nameOrId === "default") {
    return db.get(
      "SELECT * FROM namespaces WHERE account_id = ? AND name = 'default'",
      accountId
    );
  }
  // Try by ID first, then by name
  return (
    db.get("SELECT * FROM namespaces WHERE id = ? AND account_id = ?", nameOrId, accountId) ||
    db.get("SELECT * FROM namespaces WHERE name = ? AND account_id = ?", nameOrId, accountId)
  );
}

async function updateMemory(memoryId: string, body: any, currentVersion: number, reply: any) {
  const memory = db.get("SELECT * FROM memories WHERE id = ?", memoryId);
  if (!memory) return reply.status(404).send({ error: "Memory not found" });

  // Save current version to history
  db.run(
    "INSERT INTO memory_versions (id, memory_id, content, metadata, version) VALUES (?, ?, ?, ?, ?)",
    nanoid(), memoryId, memory.content, memory.metadata, currentVersion
  );

  const newVersion = currentVersion + 1;
  const newContent = body.content || memory.content;
  const newMetadata = body.metadata
    ? JSON.stringify({ ...JSON.parse(memory.metadata), ...body.metadata })
    : memory.metadata;
  const newTags = body.tags ? JSON.stringify(body.tags) : memory.tags;

  // Recompute embedding if content changed
  let embedding = memory.embedding;
  if (body.content) {
    embedding = serializeVector(textToVector(body.content));
  }

  db.run(
    `UPDATE memories SET content = ?, metadata = ?, tags = ?, embedding = ?,
     version = ?, updated_at = datetime('now') WHERE id = ?`,
    newContent, newMetadata, newTags, embedding, newVersion, memoryId
  );

  const ns = db.get("SELECT name FROM namespaces WHERE id = ?", memory.namespace_id);

  const tokensUsed = estimateTokens(newContent);
  const auth = (reply.request as any).auth;
  if (auth) {
    logUsage(auth.accountId, "update", memory.namespace_id, tokensUsed);
  }

  return {
    memory: {
      id: memoryId, namespace: ns?.name, key: memory.key,
      content: newContent, metadata: JSON.parse(newMetadata),
      tags: JSON.parse(newTags), version: newVersion,
      tokens: tokensUsed,
    },
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function logUsage(accountId: string, operation: string, namespaceId?: string, tokensUsed: number = 0) {
  db.run(
    "INSERT INTO usage_log (account_id, operation, namespace_id, tokens_used) VALUES (?, ?, ?, ?)",
    accountId, operation, namespaceId || null, tokensUsed
  );
}
