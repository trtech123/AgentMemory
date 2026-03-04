import Fastify from "fastify";
import cors from "@fastify/cors";
import { accountRoutes } from "./routes/accounts.js";
import { namespaceRoutes } from "./routes/namespaces.js";
import { memoryRoutes } from "./routes/memory.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

// Routes
await app.register(accountRoutes, { prefix: "/v1/account" });
await app.register(namespaceRoutes, { prefix: "/v1/namespaces" });
await app.register(memoryRoutes, { prefix: "/v1/memory" });

// Health
app.get("/health", async () => ({
  status: "ok",
  service: "agentmemory-api",
  version: "0.1.0",
}));

// API info
app.get("/", async () => ({
  name: "AgentMemory",
  description: "Persistent memory-as-a-service for AI agents",
  version: "0.1.0",
  docs: "https://agentmemory.dev/docs",
  endpoints: {
    "POST /v1/account/register": "Create account, get API key",
    "POST /v1/memory/store": "Store a memory",
    "POST /v1/memory/search": "Semantic search over memories",
    "GET  /v1/memory/recall/:key": "Recall memory by key",
    "PUT  /v1/memory/update/:id": "Update a memory (versioned)",
    "DELETE /v1/memory/forget/:id": "Delete a memory",
    "GET  /v1/memory/list": "List memories in a namespace",
    "GET  /v1/memory/history/:id": "Get version history",
    "POST /v1/namespaces": "Create a namespace",
    "GET  /v1/namespaces": "List namespaces",
    "POST /v1/account/tokens": "Create scoped access token",
  },
}));

const port = parseInt(process.env.PORT || "3002");
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
  console.log(`AgentMemory API running on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
