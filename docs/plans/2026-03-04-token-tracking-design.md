# Token Tracking Design

## Goal

Track two metrics in AgentMemory:
1. **Tokens stored** - how many LLM tokens are in stored memories
2. **Tokens saved** - how many tokens agents avoided regenerating by recalling from memory

## Token Estimation

Simple heuristic: `Math.ceil(text.length / 4)` (~4 chars per token). Zero dependencies, fast, good enough for tracking.

## Changes

### Helper function (db.ts or new lib/tokens.ts)

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

### Route changes

| Route | What to log | `tokens_used` value |
|-------|-------------|---------------------|
| `POST /v1/memory/store` | Tokens in stored content | `estimateTokens(content)` |
| `PUT /v1/memory/update/:id` | Tokens in updated content | `estimateTokens(newContent)` |
| `POST /v1/memory/search` | Tokens across all returned results | `sum(estimateTokens(r.content))` |
| `GET /v1/memory/recall/:key` | Tokens in recalled memory | `estimateTokens(memory.content)` |

All logged to existing `usage_log` table using the existing `tokens_used` column (currently always 0).

### `GET /v1/account/me` response enrichment

```json
{
  "token_stats": {
    "total_tokens_stored": 48230,
    "total_tokens_saved": 12450
  }
}
```

- `total_tokens_stored` = sum of `tokens_used` where operation IN ("store", "update")
- `total_tokens_saved` = sum of `tokens_used` where operation IN ("search", "recall")

## What doesn't change

- Database schema (uses existing `usage_log.tokens_used` column)
- API response shapes for memory routes (no breaking changes)
- Auth, plans, namespaces
