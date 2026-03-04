/**
 * AgentMemory TypeScript SDK
 *
 * Usage:
 *   import { AgentMemory } from '@agentmemory/sdk'
 *   const memory = new AgentMemory({ apiKey: 'am_...' })
 *   await memory.store('my-project', 'db-schema', 'Users table has id, email, name columns')
 *   const results = await memory.search('my-project', 'database schema')
 */

const DEFAULT_BASE_URL = 'https://api.agentmemory.dev'

export class AgentMemory {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL
    this.apiKey = options.apiKey || process.env.AGENTMEMORY_API_KEY
    this.defaultNamespace = options.namespace || 'default'
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    }

    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      const error = await res.text().catch(() => res.statusText)
      throw new Error(`AgentMemory API error (${res.status}): ${error}`)
    }

    return res.json()
  }

  /**
   * Store a memory
   */
  async store(namespace, key, content, options = {}) {
    const ns = namespace || this.defaultNamespace
    return this._request('POST', '/v1/memory/store', {
      namespace: ns,
      key,
      content,
      tags: options.tags || [],
      metadata: options.metadata || {},
    })
  }

  /**
   * Search memories by natural language query
   */
  async search(namespace, query, options = {}) {
    const ns = namespace || this.defaultNamespace
    const params = new URLSearchParams({
      namespace: ns,
      query,
      ...(options.limit ? { limit: String(options.limit) } : {}),
      ...(options.tags ? { tags: options.tags.join(',') } : {}),
    })
    return this._request('GET', `/v1/memory/search?${params}`)
  }

  /**
   * Recall a specific memory by key
   */
  async recall(namespace, key, version) {
    const ns = namespace || this.defaultNamespace
    const params = new URLSearchParams({ namespace: ns, key })
    if (version) params.set('version', String(version))
    return this._request('GET', `/v1/memory/recall?${params}`)
  }

  /**
   * Update an existing memory (creates a new version)
   */
  async update(namespace, key, content, options = {}) {
    const ns = namespace || this.defaultNamespace
    return this._request('PUT', '/v1/memory/update', {
      namespace: ns,
      key,
      content,
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    })
  }

  /**
   * Delete a memory
   */
  async forget(namespace, key) {
    const ns = namespace || this.defaultNamespace
    return this._request('DELETE', '/v1/memory/forget', {
      namespace: ns,
      key,
    })
  }

  /**
   * List memories in a namespace
   */
  async list(namespace, options = {}) {
    const ns = namespace || this.defaultNamespace
    const params = new URLSearchParams({ namespace: ns })
    if (options.prefix) params.set('prefix', options.prefix)
    if (options.tags) params.set('tags', options.tags.join(','))
    return this._request('GET', `/v1/memory/list?${params}`)
  }

  /**
   * List all namespaces
   */
  async namespaces() {
    return this._request('GET', '/v1/namespaces')
  }
}

export default AgentMemory
