export interface AgentMemoryOptions {
  apiKey?: string
  baseUrl?: string
  namespace?: string
}

export interface StoreOptions {
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  limit?: number
  tags?: string[]
}

export interface ListOptions {
  prefix?: string
  tags?: string[]
}

export interface Memory {
  id: string
  namespace: string
  key: string
  content: string
  tags: string[]
  metadata: Record<string, unknown>
  version: number
  created_at: string
  updated_at: string
  score?: number
}

export interface StoreResult {
  id: string
  namespace: string
  key: string
  version: number
  created_at: string
}

export interface NamespaceInfo {
  namespace: string
  count: number
}

export class AgentMemory {
  constructor(options?: AgentMemoryOptions)

  store(namespace: string | null, key: string, content: string, options?: StoreOptions): Promise<StoreResult>
  search(namespace: string | null, query: string, options?: SearchOptions): Promise<Memory[]>
  recall(namespace: string | null, key: string, version?: number): Promise<Memory | null>
  update(namespace: string | null, key: string, content: string, options?: StoreOptions): Promise<StoreResult>
  forget(namespace: string | null, key: string): Promise<boolean>
  list(namespace: string | null, options?: ListOptions): Promise<Memory[]>
  namespaces(): Promise<NamespaceInfo[]>
}

export default AgentMemory
