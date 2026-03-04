import { FastifyRequest, FastifyReply } from "fastify";
import db from "../db.js";

export interface AuthContext {
  accountId: string;
  plan: string;
  tokenId?: string;
  allowedNamespaces?: string[] | null; // null = all
  permissions: string[];
}

/**
 * Authenticate via API key (x-api-key header) or scoped access token (Bearer token).
 * Attaches auth context to request.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers["x-api-key"] as string | undefined;
  const authHeader = request.headers["authorization"] as string | undefined;

  if (apiKey) {
    // Master API key auth
    const account = db.get(
      "SELECT id, plan FROM accounts WHERE api_key = ?",
      apiKey
    );
    if (!account) {
      reply.status(401).send({ error: "Invalid API key" });
      return;
    }
    (request as any).auth = {
      accountId: account.id,
      plan: account.plan,
      permissions: ["read", "write", "admin"],
      allowedNamespaces: null,
    } satisfies AuthContext;
    return;
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const accessToken = db.get(
      "SELECT * FROM access_tokens WHERE token = ?",
      token
    );
    if (!accessToken) {
      reply.status(401).send({ error: "Invalid access token" });
      return;
    }

    // Check expiry
    if (accessToken.expires_at && new Date(accessToken.expires_at) < new Date()) {
      reply.status(401).send({ error: "Access token expired" });
      return;
    }

    const account = db.get(
      "SELECT id, plan FROM accounts WHERE id = ?",
      accessToken.account_id
    );
    if (!account) {
      reply.status(401).send({ error: "Account not found" });
      return;
    }

    const nsIds = JSON.parse(accessToken.namespace_ids);
    (request as any).auth = {
      accountId: account.id,
      plan: account.plan,
      tokenId: accessToken.id,
      allowedNamespaces: nsIds.length > 0 ? nsIds : null,
      permissions: JSON.parse(accessToken.permissions),
    } satisfies AuthContext;
    return;
  }

  reply.status(401).send({
    error: "Authentication required. Use x-api-key header or Bearer token.",
  });
}

/**
 * Check if the auth context has access to a namespace.
 */
export function canAccessNamespace(
  auth: AuthContext,
  namespaceId: string
): boolean {
  if (!auth.allowedNamespaces) return true; // master key = all access
  return auth.allowedNamespaces.includes(namespaceId);
}

/**
 * Check if the auth context has a specific permission.
 */
export function hasPermission(auth: AuthContext, perm: string): boolean {
  return auth.permissions.includes(perm);
}
