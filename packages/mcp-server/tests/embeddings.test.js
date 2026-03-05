import { describe, it, expect } from 'vitest'
import { cosineSimilarity, vectorToBuffer, bufferToVector } from '../src/embeddings.js'

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3, 4, 5]
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10)
  })

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10)
  })

  it('returns -1.0 for opposite vectors', () => {
    const a = [1, 2, 3]
    const b = [-1, -2, -3]
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10)
  })

  it('returns 0 when one vector is all zeros', () => {
    const a = [1, 2, 3]
    const b = [0, 0, 0]
    expect(cosineSimilarity(a, b)).toBe(0)
  })

  it('computes correct value for arbitrary vectors', () => {
    const a = [1, 2, 3]
    const b = [4, 5, 6]
    // dot = 4+10+18 = 32
    // normA = sqrt(1+4+9) = sqrt(14)
    // normB = sqrt(16+25+36) = sqrt(77)
    // similarity = 32 / (sqrt(14) * sqrt(77))
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77))
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 10)
  })
})

describe('vectorToBuffer / bufferToVector roundtrip', () => {
  it('roundtrips a simple vector', () => {
    const vec = [1.0, 2.5, -3.75, 0.0]
    const buf = vectorToBuffer(vec)
    const result = bufferToVector(buf)
    expect(result).toHaveLength(vec.length)
    for (let i = 0; i < vec.length; i++) {
      expect(result[i]).toBeCloseTo(vec[i], 5)
    }
  })

  it('roundtrips a 384-dim vector with correct byte length', () => {
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.1))
    const buf = vectorToBuffer(vec)
    expect(buf.byteLength).toBe(384 * 4)
    const result = bufferToVector(buf)
    expect(result).toHaveLength(384)
    for (let i = 0; i < vec.length; i++) {
      expect(result[i]).toBeCloseTo(vec[i], 5)
    }
  })
})
