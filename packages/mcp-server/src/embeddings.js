/**
 * Embeddings engine using Transformers.js
 * Lazy-loads all-MiniLM-L6-v2 on first use. Fully local, no API keys.
 */

import { pipeline } from '@huggingface/transformers'

let _embedder = null
let _loadingPromise = null
let _ready = false

/**
 * Lazy-initialize the embedding pipeline.
 * Concurrent callers await the same promise.
 */
export async function ensureReady() {
  if (_ready) return true
  if (_loadingPromise) return _loadingPromise
  _loadingPromise = (async () => {
    try {
      _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'fp32',
      })
      _ready = true
      return true
    } catch (err) {
      console.error('Failed to load embedding model:', err.message)
      _loadingPromise = null
      return false
    }
  })()
  return _loadingPromise
}

/**
 * Embed a text string into a 384-dim float32 vector.
 * Returns null if model not loaded yet.
 */
export async function embed(text) {
  if (!_ready) {
    const loaded = await ensureReady()
    if (!loaded) return null
  }
  const output = await _embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Check if embeddings engine is ready (model loaded).
 */
export function isReady() {
  return _ready
}

/**
 * Serialize a float32 vector to a Buffer for SQLite BLOB storage.
 */
export function vectorToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer)
}

/**
 * Deserialize a Buffer (SQLite BLOB) back to a float32 array.
 */
export function bufferToVector(buf) {
  const copy = new Uint8Array(buf).buffer
  return Array.from(new Float32Array(copy))
}
