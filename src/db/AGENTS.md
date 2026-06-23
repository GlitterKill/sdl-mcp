# src/db/ - LadybugDB Persistence Layer

## OVERVIEW
Graph database access layer split into 12 domain-specific modules, unified via `ladybug-queries.ts` barrel.

## STRUCTURE
- `ladybug-queries.ts` - Barrel re-export (62 importers use this facade)
- `ladybug-core.ts` - `exec`, `queryAll`, `querySingle`, `withTransaction`, `getPreparedStatement`
- `ladybug.ts` - Connection manager (singleton, `MAX_POOL_SIZE=1`)
- `ladybug-schema.ts` - Cypher DDL (idempotent, `LADYBUG_SCHEMA_VERSION=3`)
- `initGraphDb.ts` - DB path resolution + init
- `graph-db-path.ts` - Env var / config path resolution
- `schema.ts` - Legacy SQLite-era row types (still used for TS types)

### Domain modules
- `ladybug-repos.ts` - Repo + File nodes
- `ladybug-symbols.ts` - Symbol CRUD + search
- `ladybug-edges.ts` - DEPENDS_ON edges (call, import, config)
- `ladybug-versions.ts` - Version/snapshot operations
- `ladybug-slices.ts` - SliceHandle + CardHash
- `ladybug-metrics.ts` - Fan-in/out, churn
- `ladybug-feedback.ts` - Audit + AgentFeedback
- `ladybug-embeddings.ts` - Embeddings, summaries, sync artifacts
- `ladybug-config.ts` - ToolPolicyHash, TsconfigHash
- `ladybug-clusters.ts` - Cluster nodes
- `ladybug-processes.ts` - Process nodes

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
- No concurrent write connections - pool is 1 intentionally

## GRAPH SCHEMA (18 node tables, 9 relationship tables)

Key nodes: Repo, File, Symbol, Version, SymbolVersion, Metrics, Cluster, Process, SliceHandle, CardHash, Audit, AgentFeedback

Key rels: FILE_IN_REPO, SYMBOL_IN_FILE, SYMBOL_IN_REPO, DEPENDS_ON, VERSION_OF_REPO, BELONGS_TO_CLUSTER, PARTICIPATES_IN

DEPENDS_ON edge properties: `edgeType` (call/import/config), `weight`, `confidence`, `resolution`, `resolverId`, `resolutionPhase`, `provenance`

## NOTES
- Join hint fallback: `ladybug-edges.ts` tries HINT syntax first, caches whether supported
- Buffer pool: auto-sized to `min(max(RAM*0.5, 1GB), 8GB)`. Override via `SDL_LADYBUG_BUFFER_POOL_BYTES`
- `supportsCallResolutionMetadata(schemaVersion)` - feature flag for schema >= 2
