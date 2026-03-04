import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "agentmemory.db");

const SQL = await initSqlJs();

let db: SqlJsDatabase;
if (existsSync(dbPath)) {
  db = new SQL.Database(readFileSync(dbPath));
} else {
  db = new SQL.Database();
}

export function persist() {
  writeFileSync(dbPath, Buffer.from(db.export()));
}

setInterval(persist, 5000);
process.on("exit", persist);
process.on("SIGINT", () => { persist(); process.exit(0); });

// --- Schema ---

db.run(`CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

db.run(`CREATE TABLE IF NOT EXISTS namespaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, name)
)`);

db.run(`CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id),
  key TEXT,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  embedding TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  UNIQUE(namespace_id, key)
)`);

db.run(`CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

db.run(`CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  namespace_ids TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL DEFAULT '["read","write"]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  namespace_id TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

db.run("CREATE INDEX IF NOT EXISTS idx_memories_ns ON memories(namespace_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(namespace_id, key)");
db.run("CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags)");
db.run("CREATE INDEX IF NOT EXISTS idx_memory_versions ON memory_versions(memory_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_namespaces_account ON namespaces(account_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_log(account_id)");

// --- Query helpers ---

export const query = {
  run(sql: string, ...params: any[]) {
    db.run(sql, params);
    persist();
  },
  get(sql: string, ...params: any[]): any {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row: any = null;
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    }
    stmt.free();
    return row;
  },
  all(sql: string, ...params: any[]): any[] {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
    }
    stmt.free();
    return rows;
  },
};

export default query;

export const PLAN_LIMITS = {
  free:     { namespaces: 3,  memories: 1000,  search_per_day: 500 },
  pro:      { namespaces: 50, memories: 100000, search_per_day: 50000 },
  business: { namespaces: -1, memories: -1,    search_per_day: -1 },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
