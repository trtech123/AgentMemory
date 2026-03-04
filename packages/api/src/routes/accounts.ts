import { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import db from "../db.js";
import { authenticate } from "../lib/auth.js";

const registerSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function accountRoutes(app: FastifyInstance) {
  // Register new account — returns API key
  app.post("/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    const existing = db.get("SELECT id FROM accounts WHERE email = ?", body.email);
    if (existing) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const id = nanoid();
    const apiKey = `am_${nanoid(40)}`;

    db.run(
      "INSERT INTO accounts (id, name, email, api_key) VALUES (?, ?, ?, ?)",
      id, body.name, body.email, apiKey
    );

    // Create a default namespace
    const nsId = nanoid();
    db.run(
      "INSERT INTO namespaces (id, account_id, name, description) VALUES (?, ?, ?, ?)",
      nsId, id, "default", "Default memory namespace"
    );

    return {
      account: { id, name: body.name, email: body.email, plan: "free" },
      api_key: apiKey,
      default_namespace: { id: nsId, name: "default" },
    };
  });

  // Get account info
  app.get("/me", { onRequest: [authenticate] }, async (request) => {
    const { accountId } = (request as any).auth;
    const account = db.get(
      "SELECT id, name, email, plan, created_at FROM accounts WHERE id = ?",
      accountId
    );
    const nsCount = db.get(
      "SELECT COUNT(*) as count FROM namespaces WHERE account_id = ?",
      accountId
    );
    const memCount = db.get(
      `SELECT COUNT(*) as count FROM memories m
       JOIN namespaces n ON m.namespace_id = n.id
       WHERE n.account_id = ?`,
      accountId
    );
    const tokensStored = db.get(
      `SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log
       WHERE account_id = ? AND operation IN ('store', 'update')`,
      accountId
    );
    const tokensSaved = db.get(
      `SELECT COALESCE(SUM(tokens_used), 0) as total FROM usage_log
       WHERE account_id = ? AND operation IN ('search', 'recall')`,
      accountId
    );
    return {
      account,
      usage: {
        namespaces: nsCount?.count || 0,
        memories: memCount?.count || 0,
      },
      token_stats: {
        total_tokens_stored: tokensStored?.total || 0,
        total_tokens_saved: tokensSaved?.total || 0,
      },
    };
  });

  // Create a scoped access token
  app.post("/tokens", { onRequest: [authenticate] }, async (request, reply) => {
    const { accountId, permissions } = (request as any).auth;
    if (!permissions.includes("admin")) {
      return reply.status(403).send({ error: "Admin permission required" });
    }

    const body = z.object({
      name: z.string().min(1),
      namespace_ids: z.array(z.string()).default([]),
      permissions: z.array(z.enum(["read", "write"])).default(["read", "write"]),
      expires_in_days: z.number().positive().optional(),
    }).parse(request.body);

    const id = nanoid();
    const token = `amt_${nanoid(48)}`;
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86400000).toISOString()
      : null;

    db.run(
      "INSERT INTO access_tokens (id, account_id, name, token, namespace_ids, permissions, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, accountId, body.name, token,
      JSON.stringify(body.namespace_ids),
      JSON.stringify(body.permissions),
      expiresAt
    );

    return {
      access_token: {
        id, name: body.name, token,
        namespace_ids: body.namespace_ids,
        permissions: body.permissions,
        expires_at: expiresAt,
      },
    };
  });

  // List access tokens
  app.get("/tokens", { onRequest: [authenticate] }, async (request) => {
    const { accountId } = (request as any).auth;
    const tokens = db.all(
      "SELECT id, name, namespace_ids, permissions, created_at, expires_at FROM access_tokens WHERE account_id = ?",
      accountId
    );
    return {
      tokens: tokens.map((t: any) => ({
        ...t,
        namespace_ids: JSON.parse(t.namespace_ids),
        permissions: JSON.parse(t.permissions),
      })),
    };
  });

  // Delete access token
  app.delete("/tokens/:tokenId", { onRequest: [authenticate] }, async (request, reply) => {
    const { accountId } = (request as any).auth;
    const { tokenId } = request.params as any;
    const token = db.get(
      "SELECT id FROM access_tokens WHERE id = ? AND account_id = ?",
      tokenId, accountId
    );
    if (!token) return reply.status(404).send({ error: "Token not found" });
    db.run("DELETE FROM access_tokens WHERE id = ?", tokenId);
    return { success: true };
  });
}
