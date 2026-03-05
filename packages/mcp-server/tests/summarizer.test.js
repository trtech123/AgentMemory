import { describe, it, expect } from 'vitest'
import { summarize, mergeAndSummarize, SUMMARY_THRESHOLD } from '../src/summarizer.js'

describe('summarizer', () => {
  const longText = [
    'The authentication system uses JWT tokens for stateless session management.',
    'Each token contains a user ID, role, and expiration timestamp.',
    'Tokens are signed with RS256 using a rotating key pair stored in environment variables.',
    'The refresh token flow uses HTTP-only cookies to prevent XSS attacks.',
    'Rate limiting is applied at the middleware level using a sliding window algorithm.',
    'Failed login attempts are tracked per IP address with exponential backoff.',
    'The password hashing uses bcrypt with a cost factor of 12.',
    'Two-factor authentication supports both TOTP and SMS-based verification.',
    'Session revocation is handled through a Redis-backed blocklist.',
    'The OAuth2 integration supports Google, GitHub, and Microsoft providers.',
    'CORS configuration restricts origins to the frontend domain only.',
    'API keys are hashed with SHA-256 before storage in the database.',
  ].join(' ')

  describe('summarize()', () => {
    it('returns short text unchanged', () => {
      const short = 'This is a short text.'
      expect(summarize(short)).toBe(short)
    })

    it('returns text under threshold unchanged', () => {
      const text = 'A'.repeat(SUMMARY_THRESHOLD - 1)
      expect(summarize(text)).toBe(text)
    })

    it('compresses long text', () => {
      const result = summarize(longText)
      expect(result.length).toBeLessThan(longText.length)
      expect(result.length).toBeGreaterThan(0)
    })

    it('respects compression ratio', () => {
      // Tighter ratio should produce shorter output
      const loose = summarize(longText, 0.7)
      const tight = summarize(longText, 0.2)
      expect(tight.length).toBeLessThan(loose.length)
    })

    it('preserves sentence order', () => {
      const result = summarize(longText, 0.3)
      // Extract sentences from result and verify they appear in same relative order as original
      const resultSentences = result.split(/(?<=[.!?])\s+/)
      for (let i = 1; i < resultSentences.length; i++) {
        const prevIdx = longText.indexOf(resultSentences[i - 1])
        const currIdx = longText.indexOf(resultSentences[i])
        if (prevIdx >= 0 && currIdx >= 0) {
          expect(prevIdx).toBeLessThan(currIdx)
        }
      }
    })

    it('returns text with <= 3 sentences unchanged', () => {
      // Build exactly 3 real sentences that exceed the threshold
      const s1 = 'The authentication system uses JWT tokens for managing sessions across distributed systems.'
      const s2 = 'Rate limiting prevents abuse by tracking requests per IP address with sliding windows.'
      const s3 = 'Password hashing uses bcrypt with a cost factor of twelve for strong security guarantees.'
      const threeLines = `${s1} ${s2} ${s3}`
      // Only 3 sentences — should not be compressed regardless of length
      expect(threeLines.length).toBeGreaterThan(SUMMARY_THRESHOLD / 2)
      const result = summarize(threeLines)
      expect(result).toBe(threeLines)
    })

    it('handles null/empty input', () => {
      expect(summarize(null)).toBe(null)
      expect(summarize('')).toBe('')
    })
  })

  describe('mergeAndSummarize()', () => {
    it('returns empty string for empty array', () => {
      expect(mergeAndSummarize([])).toBe('')
    })

    it('handles single item', () => {
      const result = mergeAndSummarize([{ key: 'test', content: 'Short content.' }])
      expect(result).toBe('Short content.')
    })

    it('merges multiple items with key labels', () => {
      const items = [
        { key: 'auth', content: 'Authentication uses JWT tokens.' },
        { key: 'db', content: 'Database runs on PostgreSQL.' },
      ]
      const result = mergeAndSummarize(items)
      expect(result).toContain('[auth]')
      expect(result).toContain('[db]')
    })

    it('compresses long items when merging', () => {
      const items = [
        { key: 'doc1', content: longText },
        { key: 'doc2', content: longText },
      ]
      const result = mergeAndSummarize(items)
      // Merged result should be shorter than both originals combined
      expect(result.length).toBeLessThan(longText.length * 2)
    })
  })
})
