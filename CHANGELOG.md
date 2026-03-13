# Changelog

## [0.4.0] - 2026-03-13

### Breaking Changes
- Embeddings now stored as binary BLOBs instead of JSON text. Existing v0.3.0 databases are incompatible — export with v0.3.0, upgrade, then import.

### Fixed
- All 75 tests now pass (48 were broken due to missing `store.init()` in test setup)
- SQL string interpolation in usage log pruning replaced with parameterized query
- `close()` no longer throws on double-call
- `persist()` errors no longer propagate to callers
- Signal handlers wrapped in try/catch for safe shutdown

### Added
- Atomic writes: three-step rename with crash recovery
- Global `uncaughtException` and `unhandledRejection` handlers
- In-memory embedding cache (populated on first search, invalidated on writes)
- Input validation for tags (max 50, max 100 chars each) and metadata (max 10KB)
- Index on `memory_versions(memory_id, version)` for faster version lookups
- Old v0.3.0 database format detection with upgrade instructions
- `DEBUG=agentmemory` environment variable for verbose logging

### Changed
- Persist is now debounced: write operations set a dirty flag, persist fires after 1 second of inactivity. Read operations never trigger persist.
- Embedding storage reduced ~33% via binary BLOBs instead of JSON text
