import { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import db, { PLAN_LIMITS, type Plan } from "../db.js";
import { authenticate, canAccessNamespace } from "../lib/auth.js";

const createNsSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-z0-9_-]+$/i, "Name must be alphanumeric with dashes/underscores"),
  description: z.string().max(500).optional(),
});

export async function namespaceRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticate);

  // List namespaces
  app.get("/", async (request) => {
    const { accountId, allowedNamespaces } = (request as any).auth;
    let namespaces;
    if (allowedNamespaces) {
      const placeholders = allowedNamespaces.map(() => "?").join(",");
      namespaces = db.all(
        `SELECT n.*, (SELECT COUNT(*) FROM memories WHERE namespace_id = n.id) as memory_count
         FROM namespaces n WHERE n.account_id = ? AND n.id IN (${placeholders})`,
        accountId, ...allowedNamespaces
      );
    } else {
      namespaces = db.all(
        `SELECT n.*, (SELECT COUNT(*) FROM memories WHERE namespace_id = n.id) as memory_count
         FROM namespaces n WHERE n.account_id = ?`,
        accountId
      );
    }
    return { namespaces };
  });

  // Create namespace
  app.post("/", async (request, reply) => {
    const { accountId, plan } = (request as any).auth;
    const body = createNsSchema.parse(request.body);

    const limits = PLAN_LIMITS[plan as Plan];
    if (limits.namespaces > 0) {
      const count = db.get(
        "SELECT COUNT(*) as count FROM namespaces WHERE account_id = ?",
        accountId
      );
      if ((count?.count || 0) >= limits.namespaces) {
        return reply.status(403).send({
          error: `Plan limited to ${limits.namespaces} namespaces. Upgrade for more.`,
          upgrade: true,
        });
      }
    }

    const existing = db.get(
      "SELECT id FROM namespaces WHERE account_id = ? AND name = ?",
      accountId, body.name
    );
    if (existing) {
      return reply.status(409).send({ error: "Namespace already exists" });
    }

    const id = nanoid();
    db.run(
      "INSERT INTO namespaces (id, account_id, name, description) VALUES (?, ?, ?, ?)",
      id, accountId, body.name, body.description || null
    );

    return { namespace: { id, name: body.name, description: body.description } };
  });

  // Get namespace
  app.get("/:nsId", async (request, reply) => {
    const { accountId } = (request as any).auth;
    const { nsId } = request.params as any;

    const ns = db.get(
      "SELECT * FROM namespaces WHERE id = ? AND account_id = ?",
      nsId, accountId
    );
    if (!ns) return reply.status(404).send({ error: "Namespace not found" });
    if (!canAccessNamespace((request as any).auth, nsId)) {
      return reply.status(403).send({ error: "No access to this namespace" });
    }

    const memCount = db.get(
      "SELECT COUNT(*) as count FROM memories WHERE namespace_id = ?", nsId
    );
    return { namespace: { ...ns, memory_count: memCount?.count || 0 } };
  });

  // Delete namespace (and all memories in it)
  app.delete("/:nsId", async (request, reply) => {
    const { accountId, permissions } = (request as any).auth;
    if (!permissions.includes("admin") && !permissions.includes("write")) {
      return reply.status(403).send({ error: "Write permission required" });
    }
    const { nsId } = request.params as any;

    const ns = db.get(
      "SELECT * FROM namespaces WHERE id = ? AND account_id = ?",
      nsId, accountId
    );
    if (!ns) return reply.status(404).send({ error: "Namespace not found" });
    if (ns.name === "default") {
      return reply.status(400).send({ error: "Cannot delete default namespace" });
    }

    db.run("DELETE FROM memory_versions WHERE memory_id IN (SELECT id FROM memories WHERE namespace_id = ?)", nsId);
    db.run("DELETE FROM memories WHERE namespace_id = ?", nsId);
    db.run("DELETE FROM namespaces WHERE id = ?", nsId);

    return { success: true };
  });
}
