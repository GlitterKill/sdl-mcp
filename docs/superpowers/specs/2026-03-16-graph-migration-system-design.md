# Graph Schema Migration System

**Date**: 2026-03-16
**Status**: Approved
**Schema version at time of writing**: 4 (LadybugDB)

## Problem

LadybugDB schema changes currently require deleting the entire database and reindexing from scratch. Reindexing is lengthy for users with large repositories. The existing `createSchema()` uses `CREATE ... IF NOT EXISTS` which is idempotent for new tables but cannot add columns to existing tables. When the schema version doesn't match, startup throws an error directing the user to rebuild.

## Solution

A forward-only, versioned migration system using TypeScript functions. Each migration is a numbered module that receives a write connection and can execute arbitrary Cypher DDL and DML. On startup, the runner compares the DB schema version to the latest migration version and applies any pending migrations sequentially.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration direction | Forward-only | Simpler, no "down" path needed; fix-forward with new migration |
| Migration language | TypeScript functions | Supports both DDL and computed backfills |
| Newer DB than code | Best-effort (warn + continue) | Queries only touch known columns; extra structure is harmless |
| Data backfill | Required for column additions to existing tables; new table structures start empty | Existing symbols should get computed values; new systems (like Memory) have no prior data |
| Preview/dry-run | Not needed | Auto-apply on startup, log what happened |
| DDL transaction safety | Idempotent-retry, not transactional rollback | LadybugDB (Kuzu) DDL runs in autocommit mode; `CREATE`/`ALTER` cannot be rolled back inside explicit transactions |
| Version constant derivation | Derived from migration registry | Eliminates dual-source-of-truth risk between `LADYBUG_SCHEMA_VERSION` and the registry |

## Migration Module Format

Each migration lives in `src/db/migrations/` as a TypeScript file:

```typescript
// src/db/migrations/m005-add-memory-system.ts
import type { Connection } from "kuzu";

export const version = 5;
export const description = "Add Memory node table and memory relationship edges";

export async function up(conn: Connection): Promise<void> {
  // DDL + DML
}
```

### File naming

`m{NNN}-{description}.ts` — e.g., `m005-add-memory-system.ts`

### Module exports

| Export | Type | Description |
|--------|------|-------------|
| `version` | `number` | Schema version this migration brings the DB to. Must be strictly sequential, no gaps or duplicates. |
| `description` | `string` | Human-readable description for logging. |
| `up` | `(conn: Connection) => Promise<void>` | Migration function. Receives a write connection. Can run Cypher DDL and DML. |

### Rules

- Versions are sequential starting from 5 (the first migration after the current base schema version 4).
- DDL statements run in autocommit mode (no explicit transaction wrapping) — LadybugDB/Kuzu requires this for catalog operations.
- `IF NOT EXISTS` / `IF EXISTS` clauses are **required** for all DDL to ensure idempotency. This is the primary crash-recovery mechanism: if a migration partially applies and the process dies, re-running it on next startup will skip already-applied DDL statements.
- DML statements (data backfills) within a migration should use transactions where appropriate for data consistency.
- The migration runner updates `SchemaVersion` only after all DDL+DML in the migration succeed.
- Migrations must be idempotent — re-running a migration against a DB that already has its changes must not fail.

## Migration Registry

`src/db/migrations/index.ts` imports all migration modules and exports an ordered array:

```typescript
import * as m005 from "./m005-add-memory-system.js";

export interface Migration {
  version: number;
  description: string;
  up: (conn: Connection) => Promise<void>;
}

export const migrations: Migration[] = [m005];
```

The registry validates at import time:
- All versions are sequential with no gaps
- No duplicate versions
- Versions start at `BASE_SCHEMA_VERSION + 1` (currently 5)

`LADYBUG_SCHEMA_VERSION` is derived from the registry:
```typescript
export const LADYBUG_SCHEMA_VERSION = migrations.length > 0
  ? migrations[migrations.length - 1].version
  : BASE_SCHEMA_VERSION;
```
This eliminates the risk of a developer adding a migration but forgetting to bump the constant.

## Migration Runner

`src/db/migration-runner.ts` provides the core `runPendingMigrations()` function.

### Algorithm

```
function runPendingMigrations(writeConn, currentVersion, migrations):
  pending = migrations.filter(m => m.version > currentVersion)
  sort pending by version ascending

  for each migration in pending:
    startTime = now()
    migration.up(writeConn)          // DDL runs in autocommit; DML may use internal transactions
    UPDATE SchemaVersion SET schemaVersion = migration.version, updatedAt = now
    elapsed = now() - startTime
    log info: "Applied migration {name} (v{prev} -> v{migration.version}) in {elapsed}ms"

  if no pending:
    log info: "Schema up to date at version {currentVersion}"

  // Clear prepared statement cache after schema changes
  clearPreparedStatementCache(writeConn)
```

**Important**: The `writeConn` parameter must be the dedicated write connection obtained via `withWriteConn()`. Migrations must never use read pool connections.

### Error handling

If a migration fails:
1. Log the error with migration name, version, and error message
2. Throw a `DatabaseError` so startup aborts
3. The DB remains at the last successfully applied version
4. **Crash recovery**: Since DDL is not transactional, a failed migration may leave the schema partially applied. On next startup, the migration re-runs. All DDL uses `IF NOT EXISTS`/`IF EXISTS` so already-applied statements are skipped. DML backfills should also be idempotent (e.g., use `MERGE` instead of `CREATE` for data).

## Changes to Startup Flow

### Current flow (initLadybugDb)

1. Open database
2. `createSchema()` — all `CREATE ... IF NOT EXISTS`, sets SchemaVersion to `LADYBUG_SCHEMA_VERSION`
3. Read SchemaVersion — if mismatch, throw error

### New flow (initLadybugDb)

1. Open database, initialize connection pool
2. Attempt to read SchemaVersion from DB (via write connection)
   - Wrap `getSchemaVersion()` in try/catch: if the `SchemaVersion` table doesn't exist (query throws), treat as `null`
3. **If null (fresh DB)**: run `createSchema()` as today — creates everything at latest version
4. **If version < latest**: run migration runner via `withWriteConn()` — applies pending migrations in order
5. **If version > latest**: log warning ("DB schema version {db} is newer than code version {code}, running in best-effort mode"), continue
6. **If version === latest**: no-op
7. After migrations: clear prepared statement cache on all pool connections (write + read pool) since DDL may have invalidated cached statements
8. Read SchemaVersion again to confirm, log final state

### Detecting fresh vs. existing databases

Reading `SchemaVersion` before the table exists will throw a Kuzu error. The runner handles three cases:
- **Table doesn't exist** (query throws) → fresh DB → run `createSchema()`
- **Table exists, row present** → existing DB → compare versions, run migrations if needed
- **Table exists, no row** → corrupted state → run `createSchema()` which uses `MERGE` to re-create the row

### Key changes

- `createSchema()` is only called for fresh databases (no existing SchemaVersion)
- The hard version-mismatch error is removed; migrations replace it for upgrades, best-effort for downgrades
- `LADYBUG_SCHEMA_VERSION` is derived from the migration registry (no separate constant to keep in sync)
- Prepared statement cache is cleared after migrations to prevent stale statement errors
- `ladybug-core.ts` gains an exported `clearPreparedStatementCache(conn)` function

## First Migration: m005-add-memory-system

Upgrades v4 databases to v5 by adding the Memory system schema.

### DDL

```cypher
CREATE NODE TABLE IF NOT EXISTS Memory (
  memoryId STRING PRIMARY KEY,
  repoId STRING,
  type STRING,
  title STRING,
  content STRING,
  contentHash STRING,
  searchText STRING,
  tagsJson STRING DEFAULT '[]',
  confidence DOUBLE DEFAULT 0.8,
  createdAt STRING,
  updatedAt STRING,
  createdByVersion STRING,
  stale BOOLEAN DEFAULT false,
  staleVersion STRING,
  sourceFile STRING,
  deleted BOOLEAN DEFAULT false
)

CREATE REL TABLE IF NOT EXISTS HAS_MEMORY (FROM Repo TO Memory)
CREATE REL TABLE IF NOT EXISTS MEMORY_OF (FROM Memory TO Symbol)
CREATE REL TABLE IF NOT EXISTS MEMORY_OF_FILE (FROM Memory TO File)

CREATE INDEX IF NOT EXISTS idx_memory_repoId ON Memory(repoId)
CREATE INDEX IF NOT EXISTS idx_memory_type ON Memory(type)
CREATE INDEX IF NOT EXISTS idx_memory_contentHash ON Memory(contentHash)
```

### Data backfill

None required — Memory tables start empty since there is no prior memory data to migrate.

## Doctor Command Updates

`sdl-mcp doctor` updated to show (within the existing `checkLadybugDb` check, not a separate check):
- Current DB schema version
- Code's expected schema version
- Number of pending migrations (informational only, no action)

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/db/migrations/index.ts` | Create | Migration registry + `Migration` type |
| `src/db/migrations/m005-add-memory-system.ts` | Create | First migration (Memory system) |
| `src/db/migration-runner.ts` | Create | Runner: applies pending migrations |
| `src/db/ladybug-schema.ts` | Modify | Remove hardcoded `LADYBUG_SCHEMA_VERSION`; re-export from registry. Keep `createSchema()` and `getSchemaVersion()` |
| `src/db/ladybug-core.ts` | Modify | Add exported `clearPreparedStatementCache(conn)` function |
| `src/db/ladybug.ts` | Modify | Change `initLadybugDb()` to new startup flow |
| `src/cli/commands/doctor.ts` | Modify | Show migration status in existing `checkLadybugDb` |
| `tests/` | Create | Unit tests for runner, registry validation, and idempotent re-run |
