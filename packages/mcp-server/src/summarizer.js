/**
 * Extractive Summarizer
 *
 * Scores sentences by TF-IDF importance with positional boosting,
 * then returns the top-ranked sentences in original order.
 * No external dependencies — pure algorithmic.
 */

const SUMMARY_THRESHOLD = 500 // chars — don't summarize short content
const DEFAULT_RATIO = 0.3    // keep ~30% of sentences

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2)
}

function splitSentences(text) {
  // Normalize paragraph breaks and list items into sentence boundaries
  const normalized = text
    .replace(/\n{2,}/g, ' \n\n ')
    .replace(/^[\s]*[-*]\s+/gm, '\n')

  // Split on sentence-ending punctuation, double newlines, or single newlines for list items
  const raw = normalized
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  return raw
}

/**
 * Summarize text using extractive sentence scoring.
 * @param {string} text - Input text to summarize
 * @param {number} ratio - Target ratio of sentences to keep (0-1, default 0.3)
 * @returns {string} Compressed text
 */
export function summarize(text, ratio = DEFAULT_RATIO) {
  if (!text || text.length <= SUMMARY_THRESHOLD) return text

  const sentences = splitSentences(text)
  if (sentences.length <= 3) return text

  // Compute document frequency (how many sentences contain each term)
  const sentenceTokens = sentences.map(s => tokenize(s))
  const docFreq = {}
  for (const tokens of sentenceTokens) {
    const unique = new Set(tokens)
    for (const t of unique) {
      docFreq[t] = (docFreq[t] || 0) + 1
    }
  }

  // Score each sentence
  const scored = sentences.map((sentence, i) => {
    const tokens = sentenceTokens[i]
    if (tokens.length === 0) return { sentence, score: 0, index: i }

    // Term frequencies for this sentence
    const freq = {}
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1

    // TF-IDF score
    let score = 0
    for (const [term, count] of Object.entries(freq)) {
      const tf = count / tokens.length
      const idf = Math.log(sentences.length / (docFreq[term] || 1))
      score += tf * idf
    }
    score /= tokens.length // normalize by sentence length

    // Positional boost — first/last sentences carry more context
    if (i === 0 || i === sentences.length - 1) score *= 1.5
    if (i === 1) score *= 1.2

    return { sentence, score, index: i }
  })

  // Select top sentences to hit target ratio, restore original order
  const targetCount = Math.max(1, Math.ceil(sentences.length * ratio))
  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, targetCount)
    .sort((a, b) => a.index - b.index)

  return selected.map(s => s.sentence).join(' ')
}

/**
 * Merge multiple texts into one compressed summary.
 * Concatenates then summarizes the combined text at a tighter ratio.
 * @param {Array<{key: string, content: string}>} items - Memory items to merge
 * @param {number} ratio - Compression ratio (default 0.25 — tighter for bulk)
 * @returns {string} Merged compressed text
 */
export function mergeAndSummarize(items, ratio = 0.25) {
  if (items.length === 0) return ''
  if (items.length === 1) return summarize(items[0].content, ratio)

  // Summarize each item individually first, then merge
  const parts = items.map(item => {
    const compressed = summarize(item.content, ratio)
    return `[${item.key}]: ${compressed}`
  })

  return parts.join('\n\n')
}

export { SUMMARY_THRESHOLD, DEFAULT_RATIO }
