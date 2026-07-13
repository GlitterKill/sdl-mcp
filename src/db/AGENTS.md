# src/db/ - LadybugDB Persistence Layer

## OVERVIEW
Graph database access layer split into domain-specific modules, unified via the `ladybug-queries.ts` compatibility barrel.

## STRUCTURE
- `ladybug-queries.ts` - Compatibility barrel for DB query exports
- `ladybug-core.ts` - `exec`, `queryAll`, `querySingle`, `withTransaction`, `getPreparedStatement`
- `ladybug.ts` - Configurable read pool (default 4) plus one dedicated write connection
- `ladybug-schema.ts` - Cypher DDL (idempotent, `LADYBUG_SCHEMA_VERSION=3`)
- `initGraphDb.ts` - DB path resolution + init
- `graph-db-path.ts` - Env var / config path resolution
- `schema.ts` - Legacy SQLite-era row types (still used for TS types)

### Domain modules
- Graph identity/state: `ladybug-repos.ts`, `ladybug-symbols.ts`, `ladybug-edges.ts`, `ladybug-versions.ts`, `ladybug-slices.ts`
- Index lifecycle/provider state: `ladybug-index-lifecycle.ts`, `ladybug-provider-first.ts`, `ladybug-shadow-finalization.ts`, `ladybug-shadow-clusters.ts`, `ladybug-unresolved-imports.ts`
- Retrieval/analysis: `ladybug-graph-read.ts`, `ladybug-retrieval.ts`, `ladybug-algorithms.ts`, `ladybug-metrics.ts`, `ladybug-clusters.ts`, `ladybug-processes.ts`, `ladybug-viewer.ts`
- Semantic/enrichment: `ladybug-embeddings.ts`, `ladybug-symbol-embeddings.ts`, `ladybug-semantic.ts`, `ladybug-file-summaries.ts`
- Operational state: `ladybug-feedback.ts`, `ladybug-memory.ts`, `ladybug-usage.ts`, `ladybug-prefetch-outcomes.ts`, `ladybug-config.ts`, `ladybug-scip.ts`, `ladybug-derived-state.ts`
- Shared write batching: `ladybug-batching.ts`

## CONVENTIONS
- Always use `MERGE` (never `CREATE`) for upserts
- Always `normalizePath()` paths before storage
- Always wrap numeric results with `toNumber()` (LadybugDB returns bigint for INT64)
- Always use `$paramName` in Cypher (never string interpolation)
- Always close QueryResult (`exec`/`queryAll`/`querySingle` handle this automatically)
- Use `withTransaction()` for multi-statement writes (supports nesting via depth counter)
- Import from `ladybug-queries.ts` barrel for backward compat, or specific module for new code

## ANTI-PATTERNS
- No raw `conn.query()` calls - use `exec`/`queryAll`/`querySingle`
- No `ALTER TABLE` - LadybugDB does not support it; bump `LADYBUG_SCHEMA_VERSION` and rebuild
- Do not bypass `writeLimiter` or the per-session write-body limiter with raw writes; LadybugDB permits one write transaction at a time

## GRAPH SCHEMA (18 node tables, 9 relationship tables)

Key nodes: Repo, File, Symbol, Version, SymbolVersion, Metrics, Cluster, Process, SliceHandle, CardHash, Audit, AgentFeedback

Key rels: FILE_IN_REPO, SYMBOL_IN_FILE, SYMBOL_IN_REPO, DEPENDS_ON, VERSION_OF_REPO, BELONGS_TO_CLUSTER, PARTICIPATES_IN

DEPENDS_ON edge properties: `edgeType` (call/import/config), `weight`, `confidence`, `resolution`, `resolverId`, `resolutionPhase`, `provenance`

## NOTES
- Join hint fallback: `ladybug-edges.ts` tries HINT syntax first, caches whether supported
- Buffer pool: auto-sized to `min(max(RAM*0.5, 1GB), 8GB)`. Override via `SDL_LADYBUG_BUFFER_POOL_BYTES`
- `supportsCallResolutionMetadata(schemaVersion)` - feature flag for schema >= 2
