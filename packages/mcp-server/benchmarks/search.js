/**
 * Benchmark: search performance at scale
 * Usage: node benchmarks/search.js [count]
 * Default count: 1000
 */

import { MemoryStore } from '../src/store.js'

const count = parseInt(process.argv[2] || '1000', 10)
console.log(`Benchmarking search with ${count} memories...`)

const store = new MemoryStore(':memory:')
await store.init()

// Populate
const start = performance.now()
for (let i = 0; i < count; i++) {
  await store.store('bench', `key-${i}`, `Memory number ${i} about topic ${i % 10} with content for testing search performance`)
}
const populateMs = performance.now() - start
console.log(`Populated ${count} memories in ${(populateMs / 1000).toFixed(1)}s`)

// Search
const searchStart = performance.now()
const results = await store.search('bench', 'topic search performance testing', 10)
const searchMs = performance.now() - searchStart
console.log(`Search returned ${results.length} results in ${searchMs.toFixed(0)}ms`)

if (searchMs > 2000) {
  console.error(`FAIL: Search took ${searchMs.toFixed(0)}ms (target: < 2000ms)`)
  process.exit(1)
} else {
  console.log(`PASS: Search completed within target`)
}

store.close()
