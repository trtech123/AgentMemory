/**
 * Lightweight vector search engine for AgentMemory.
 *
 * MVP approach: TF-IDF style embeddings computed locally.
 * No external API dependency. Fast enough for ~100k memories.
 *
 * For production, swap in OpenAI/Cohere embeddings via the
 * EMBEDDING_API_URL env var.
 */

// Simple tokenizer: lowercase, split on non-alphanumeric, remove stopwords
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "about", "up", "it", "its", "this", "that", "i",
  "me", "my", "we", "our", "you", "your", "he", "him", "his", "she",
  "her", "they", "them", "their", "what", "which", "who", "whom",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Build a term-frequency vector from text.
 * Returns a map of term -> normalized frequency.
 */
export function textToVector(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  // Normalize
  const max = Math.max(...freq.values(), 1);
  for (const [k, v] of freq) {
    freq.set(k, v / max);
  }
  return freq;
}

/**
 * Serialize a vector to a compact JSON string for storage.
 */
export function serializeVector(vec: Map<string, number>): string {
  const obj: Record<string, number> = {};
  for (const [k, v] of vec) {
    obj[k] = Math.round(v * 10000) / 10000;
  }
  return JSON.stringify(obj);
}

/**
 * Deserialize a stored vector back to a Map.
 */
export function deserializeVector(str: string): Map<string, number> {
  const obj = JSON.parse(str) as Record<string, number>;
  return new Map(Object.entries(obj));
}

/**
 * Cosine similarity between two term-frequency vectors.
 */
export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>
): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const [k, v] of a) {
    magA += v * v;
    const bv = b.get(k);
    if (bv !== undefined) {
      dot += v * bv;
    }
  }
  for (const [, v] of b) {
    magB += v * v;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Search memories by semantic similarity.
 * Returns scored results sorted by relevance.
 */
export function semanticSearch(
  queryText: string,
  memories: Array<{ id: string; content: string; embedding: string | null }>,
  topK: number = 10,
  threshold: number = 0.05
): Array<{ id: string; score: number }> {
  const queryVec = textToVector(queryText);
  const scored: Array<{ id: string; score: number }> = [];

  for (const mem of memories) {
    let memVec: Map<string, number>;
    if (mem.embedding) {
      memVec = deserializeVector(mem.embedding);
    } else {
      memVec = textToVector(mem.content);
    }

    const score = cosineSimilarity(queryVec, memVec);
    if (score >= threshold) {
      scored.push({ id: mem.id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
