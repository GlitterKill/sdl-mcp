# Graph Schema Migration System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a forward-only versioned migration system to LadybugDB so schema changes don't require full DB rebuild + reindex.

**Architecture:** Numbered TypeScript migration modules are registered in an ordered array. On startup, the runner reads the current schema version from the DB, then applies any pending migrations sequentially. DDL runs in autocommit (Kuzu requirement); idempotent `IF NOT EXISTS` clauses handle crash recovery. `LADYBUG_SCHEMA_VERSION` is derived from the registry, eliminating dual-source-of-truth risk.

**Tech Stack:** TypeScript (ESM, strict), LadybugDB/Kuzu 0.15.1, node:test for testing

**Spec:** `docs/superpowers/specs/2026-03-16-graph-migration-system-design.md`

---

## Chunk 1: Core Infrastructure

### Task 1: Add `clearPreparedStatementCache` to ladybug-core.ts

**Files:**
- Modify: `src/db/ladybug-core.ts:14-17` (WeakMap declaration area)
- Test: `tests/unit/migration-runner.test.ts` (created in Task 3)

- [ ] **Step 1: Add the export to ladybug-core.ts**

Add after line 17 (after the `transactionDepthByConn` declaration):

```typescript
/**
 * Clear the prepared statement cache for a specific connection.
 * Must be called after DDL schema changes (migrations) so that
 * cached prepared statements referencing the old catalog are evicted.
 */
export function clearPreparedStatementCache(conn: Connection): void {
  preparedStatementCacheByConn.delete(conn);
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add src/db/ladybug-core.ts
git commit -m "feat(db): add clearPreparedStatementCache export for migration support"
```

---

### Task 2: Create migration registry and types

**Files:**
- Create: `src/db/migrations/types.ts`
- Create: `src/db/migrations/index.ts`
- Modify: `src/db/ladybug-schema.ts:369` (remove hardcoded `LADYBUG_SCHEMA_VERSION`)

- [ ] **Step 1: Create `src/db/migrations/types.ts`**

```typescript
import type { Connection } from "kuzu";

/**
 * A single forward-only schema migration.
 *
 * Rules:
 * - `version` must be sequential (no gaps, no duplicates)
 * - DDL in `up()` must use IF NOT EXISTS / IF EXISTS for idempotency
 * - DML backfills should use MERGE for crash-recovery safety
 */
export interface Migration {
  /** Schema version this migration brings the DB to. */
  version: number;
  /** Human-readable description for logging. */
  description: string;
  /** Migration function. Receives the dedicated write connection. */
  up: (conn: Connection) => Promise<void>;
}
```

- [ ] **Step 2: Create `src/db/migrations/index.ts`**

```typescript
import type { Migration } from "./types.js";
import { DatabaseError } from "../../domain/errors.js";

/**
 * Base schema version — the version that createSchema() produces for
 * fresh databases. Migrations start at BASE_SCHEMA_VERSION + 1.
 */
export const BASE_SCHEMA_VERSION = 4;

// Import migrations here as they are added:
// import * as m005 from "./m005-add-memory-system.js";

/** Ordered list of all migrations. Must be sorted by version ascending. */
export const migrations: Migration[] = [
  // m005,   // uncommented in Task 4
];

// --- Registry validation (runs at import time) ---
function validateMigrations(migs: Migration[]): void {
  for (let i = 0; i < migs.length; i++) {
    const m = migs[i];
    const expectedVersion = BASE_SCHEMA_VERSION + 1 + i;
    if (m.version !== expectedVersion) {
      throw new DatabaseError(
        `Migration registry error: expected version ${expectedVersion} at index ${i}, ` +
          `got ${m.version} ("${m.description}"). Versions must be sequential starting at ${BASE_SCHEMA_VERSION + 1}.`,
      );
    }
  }
}

validateMigrations(migrations);

/**
 * The latest schema version. Derived from the registry so there is
 * no separate constant to keep in sync.
 */
export const LADYBUG_SCHEMA_VERSION: number =
  migrations.length > 0
    ? migrations[migrations.length - 1].version
    : BASE_SCHEMA_VERSION;

export type { Migration } from "./types.js";
```

- [ ] **Step 3: Update `src/db/ladybug-schema.ts` to re-export from registry**

Replace line 369:
```typescript
export const LADYBUG_SCHEMA_VERSION = 4;
```
With:
```typescript
export { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";
```

Also remove the `LADYBUG_SCHEMA_VERSION` from the `createSchema()` MERGE call and import it:

At the top of the file, the existing import is:
```typescript
import { exec } from "./ladybug-core.js";
```

Change to:
```typescript
import { exec } from "./ladybug-core.js";
import { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";
```

Wait — `LADYBUG_SCHEMA_VERSION` is already used inside `createSchema()` at line 344. Since we're re-exporting it from the registry, and `ladybug-schema.ts` will import it from `./migrations/index.js`, we need to make sure the import doesn't create a circular dependency.

Check: `migrations/index.ts` does NOT import from `ladybug-schema.ts`. It imports from `../../domain/errors.js` only. So this is safe.

The final change to `ladybug-schema.ts`:
1. Remove line 369 (`export const LADYBUG_SCHEMA_VERSION = 4;`)
2. Add import at the top: `import { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";`
3. Add re-export at the bottom: `export { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";`

- [ ] **Step 4: Verify build passes**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No new errors. All existing imports of `LADYBUG_SCHEMA_VERSION` from `ladybug-schema.js` continue to work via re-export.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/types.ts src/db/migrations/index.ts src/db/ladybug-schema.ts
git commit -m "feat(db): add migration registry with version derivation"
```

---

### Task 3: Create migration runner

**Files:**
- Create: `src/db/migration-runner.ts`
- Test: `tests/unit/migration-runner.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";

// Import from dist/ (tests run against compiled output)
const { validateMigrationList, computePendingMigrations } = await import(
  "../../dist/db/migration-runner.js"
);

describe("migration-runner", () => {
  describe("validateMigrationList", () => {
    it("accepts an empty list", () => {
      assert.doesNotThrow(() => validateMigrationList([], 4));
    });

    it("accepts a valid sequential list", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 6, description: "m006", up: async () => {} },
      ];
      assert.doesNotThrow(() => validateMigrationList(migs, 4));
    });

    it("rejects a gap in versions", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 7, description: "m007", up: async () => {} },
      ];
      assert.throws(() => validateMigrationList(migs, 4), /sequential/i);
    });

    it("rejects duplicate versions", () => {
      const migs = [
        { version: 5, description: "m005", up: async () => {} },
        { version: 5, description: "m005-dup", up: async () => {} },
      ];
      assert.throws(() => validateMigrationList(migs, 4), /sequential/i);
    });
  });

  describe("computePendingMigrations", () => {
    const allMigrations = [
      { version: 5, description: "m005", up: async () => {} },
      { version: 6, description: "m006", up: async () => {} },
      { version: 7, description: "m007", up: async () => {} },
    ];

    it("returns all migrations when DB is at base version", () => {
      const pending = computePendingMigrations(allMigrations, 4);
      assert.strictEqual(pending.length, 3);
      assert.strictEqual(pending[0].version, 5);
    });

    it("returns only newer migrations", () => {
      const pending = computePendingMigrations(allMigrations, 6);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].version, 7);
    });

    it("returns empty when DB is up to date", () => {
      const pending = computePendingMigrations(allMigrations, 7);
      assert.strictEqual(pending.length, 0);
    });

    it("returns empty when DB is newer than code", () => {
      const pending = computePendingMigrations(allMigrations, 10);
      assert.strictEqual(pending.length, 0);
    });
  });
});
```

- [ ] **Step 2: Build and run test to verify it fails**

Run: `cd sdl-mcp && npm run build:all && node --import tsx --test tests/unit/migration-runner.test.ts`
Expected: FAIL — `migration-runner.js` module not found

- [ ] **Step 3: Write `src/db/migration-runner.ts`**

```typescript
/**
 * migration-runner.ts — Forward-only schema migration runner for LadybugDB.
 *
 * Applies pending migrations sequentially. DDL runs in autocommit mode
 * (Kuzu requirement). Idempotent IF NOT EXISTS clauses handle crash recovery.
 */
import type { Connection } from "kuzu";
import type { Migration } from "./migrations/types.js";
import { exec, clearPreparedStatementCache } from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";

/**
 * Validate that a migration list is sequential with no gaps or duplicates.
 * Exported for testing.
 */
export function validateMigrationList(
  migs: Migration[],
  baseVersion: number,
): void {
  for (let i = 0; i < migs.length; i++) {
    const expected = baseVersion + 1 + i;
    if (migs[i].version !== expected) {
      throw new DatabaseError(
        `Migration registry error: expected version ${expected} at index ${i}, ` +
          `got ${migs[i].version} ("${migs[i].description}"). ` +
          `Versions must be sequential starting at ${baseVersion + 1}.`,
      );
    }
  }
}

/**
 * Return the subset of migrations that need to be applied.
 * Exported for testing.
 */
export function computePendingMigrations(
  migs: Migration[],
  currentVersion: number,
): Migration[] {
  return migs
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply all pending migrations to bring the DB schema up to date.
 *
 * @param writeConn - The dedicated write connection (from withWriteConn)
 * @param currentVersion - The current schema version in the DB
 * @param allMigrations - The full ordered migration list from the registry
 * @returns The new schema version after all migrations are applied
 */
export async function runPendingMigrations(
  writeConn: Connection,
  currentVersion: number,
  allMigrations: Migration[],
): Promise<number> {
  const pending = computePendingMigrations(allMigrations, currentVersion);

  if (pending.length === 0) {
    logger.info("Schema up to date", { version: currentVersion });
    return currentVersion;
  }

  logger.info("Applying schema migrations", {
    from: currentVersion,
    to: pending[pending.length - 1].version,
    count: pending.length,
  });

  let appliedVersion = currentVersion;

  for (const migration of pending) {
    const startMs = Date.now();
    const prevVersion = appliedVersion;

    try {
      // Run the migration (DDL in autocommit, DML may use internal transactions)
      await migration.up(writeConn);

      // Update SchemaVersion after successful migration
      const now = new Date().toISOString();
      await exec(
        writeConn,
        `MERGE (sv:SchemaVersion {id: 'current'})
         ON CREATE SET sv.schemaVersion = $version, sv.createdAt = $now, sv.updatedAt = $now
         ON MATCH SET sv.schemaVersion = $version, sv.updatedAt = $now`,
        { version: migration.version, now },
      );

      appliedVersion = migration.version;
      const elapsedMs = Date.now() - startMs;

      logger.info("Applied migration", {
        description: migration.description,
        from: prevVersion,
        to: migration.version,
        elapsedMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Migration failed", {
        description: migration.description,
        version: migration.version,
        error: msg,
      });
      throw new DatabaseError(
        `Migration "${migration.description}" (v${prevVersion} -> v${migration.version}) failed: ${msg}. ` +
          `The database is at schema version ${appliedVersion}. ` +
          `The migration uses IF NOT EXISTS clauses and will retry on next startup.`,
      );
    }
  }

  // Clear prepared statement cache after DDL changes
  clearPreparedStatementCache(writeConn);

  return appliedVersion;
}
```

- [ ] **Step 4: Build and run tests**

Run: `cd sdl-mcp && npm run build:all && node --import tsx --test tests/unit/migration-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migration-runner.ts tests/unit/migration-runner.test.ts
git commit -m "feat(db): add migration runner with pending migration computation"
```

---

## Chunk 2: Startup Flow + First Migration

### Task 4: Create first migration (m005-add-memory-system)

**Files:**
- Create: `src/db/migrations/m005-add-memory-system.ts`
- Modify: `src/db/migrations/index.ts` (uncomment m005 import)

- [ ] **Step 1: Create `src/db/migrations/m005-add-memory-system.ts`**

```typescript
/**
 * m005 — Add Memory node table and memory relationship edges.
 *
 * Upgrades v4 databases to v5. No data backfill needed —
 * Memory tables start empty since there is no prior memory data.
 */
import type { Connection } from "kuzu";

export const version = 5;
export const description = "Add Memory node table and memory relationship edges";

async function execDdl(conn: Connection, ddl: string): Promise<void> {
  const result = await conn.query(ddl);
  result.close();
}

export async function up(conn: Connection): Promise<void> {
  // Node table
  await execDdl(
    conn,
    `CREATE NODE TABLE IF NOT EXISTS Memory (
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
    )`,
  );

  // Relationship tables
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY (FROM Repo TO Memory)`,
  );
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS MEMORY_OF (FROM Memory TO Symbol)`,
  );
  await execDdl(
    conn,
    `CREATE REL TABLE IF NOT EXISTS MEMORY_OF_FILE (FROM Memory TO File)`,
  );

  // Indexes (may not be supported on all Kuzu versions)
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_memory_repoId ON Memory(repoId)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_type ON Memory(type)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_contentHash ON Memory(contentHash)`,
  ];
  for (const idx of indexes) {
    try {
      await execDdl(conn, idx);
    } catch {
      // Index creation may not be supported; skip gracefully
    }
  }
}
```

- [ ] **Step 2: Register m005 in the migration index**

In `src/db/migrations/index.ts`, uncomment the import and add to the array:

Change:
```typescript
// import * as m005 from "./m005-add-memory-system.js";
```
To:
```typescript
import * as m005 from "./m005-add-memory-system.js";
```

Change:
```typescript
export const migrations: Migration[] = [
  // m005,   // uncommented in Task 4
];
```
To:
```typescript
export const migrations: Migration[] = [
  m005,
];
```

- [ ] **Step 3: Update `tests/unit/ladybug-schema.test.ts` for version 5**

The test at line 102 asserts `LADYBUG_SCHEMA_VERSION === 4`. With m005 registered, the derived version is now 5.

Change:
```typescript
      assert.strictEqual(LADYBUG_SCHEMA_VERSION, 4);
```
To:
```typescript
      assert.strictEqual(LADYBUG_SCHEMA_VERSION, 5);
```

- [ ] **Step 4: Verify build passes and version is now 5**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No errors. The derived constant should now be 5 since the registry has one migration at version 5.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/m005-add-memory-system.ts src/db/migrations/index.ts tests/unit/ladybug-schema.test.ts
git commit -m "feat(db): add m005 migration for Memory system schema"
```

---

### Task 5: Rewrite `initLadybugDb()` startup flow

**Files:**
- Modify: `src/db/ladybug.ts:10-14` (imports), `src/db/ladybug.ts:444-484` (`initLadybugDb` function)

- [ ] **Step 1: Update imports in `ladybug.ts`**

Replace lines 10-14:
```typescript
import {
  createSchema,
  getSchemaVersion,
  LADYBUG_SCHEMA_VERSION,
} from "./ladybug-schema.js";
```
With:
```typescript
import { createSchema, getSchemaVersion } from "./ladybug-schema.js";
import { LADYBUG_SCHEMA_VERSION, migrations } from "./migrations/index.js";
import { runPendingMigrations } from "./migration-runner.js";
import { clearPreparedStatementCache } from "./ladybug-core.js";
```

- [ ] **Step 2: Rewrite `initLadybugDb()` function**

Replace the function body at lines 444-484 with:

```typescript
export async function initLadybugDb(dbPath: string): Promise<void> {
  const normalizedPath = normalizePath(normalizeGraphDbPath(dbPath));

  logger.info("Initializing LadybugDB", { path: normalizedPath });

  const parentDir = dirname(normalizedPath);
  if (parentDir && parentDir !== "." && !existsSync(parentDir)) {
    try {
      mkdirSync(parentDir, { recursive: true });
      logger.debug("Created LadybugDB parent directory", { path: parentDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(
        `Failed to create LadybugDB parent directory at ${parentDir}: ${msg}`,
      );
    }
  }

  try {
    // Step 1: Open database and initialize connection pool
    await getLadybugDb(normalizedPath);
    await getLadybugConn(); // triggers pool init

    // Step 2: Read current schema version (may throw if table doesn't exist)
    let currentVersion: number | null = null;
    try {
      const conn = await getLadybugConn();
      currentVersion = await getSchemaVersion(conn);
    } catch {
      // SchemaVersion table does not exist — fresh database
      currentVersion = null;
    }

    if (currentVersion === null) {
      // Fresh DB (SchemaVersion table missing) or corrupted (table exists, no row).
      // Run createSchema() to set up everything at latest version.
      logger.info("Fresh database detected, creating schema", {
        version: LADYBUG_SCHEMA_VERSION,
      });
      await withWriteConn(async (wConn) => {
        await createSchema(wConn);
      });
    } else if (currentVersion < LADYBUG_SCHEMA_VERSION) {
      // Existing DB needs migration — capture version in const for TS narrowing
      const dbVersion = currentVersion;
      await withWriteConn(async (wConn) => {
        await runPendingMigrations(wConn, dbVersion, migrations);
      });
      // Clear prepared statement cache on read pool connections too
      for (const conn of getReadPool()) {
        clearPreparedStatementCache(conn);
      }
    } else if (currentVersion > LADYBUG_SCHEMA_VERSION) {
      // Step 5: DB is newer than code — best-effort
      logger.warn("Database schema is newer than this version of SDL-MCP", {
        dbVersion: currentVersion,
        codeVersion: LADYBUG_SCHEMA_VERSION,
        message: "Running in best-effort mode",
      });
    }
    // else: currentVersion === LADYBUG_SCHEMA_VERSION — no-op

    // Step 8: Confirm final state
    const finalConn = await getLadybugConn();
    const finalVersion = await getSchemaVersion(finalConn);
    logger.info("LadybugDB schema initialized", {
      path: normalizedPath,
      schemaVersion: finalVersion,
    });
  } catch (err) {
    if (err instanceof DatabaseError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new DatabaseError(formatReindexGuidanceError(normalizedPath, msg));
  }
}
```

- [ ] **Step 3: Expose `getReadPool()` for cache clearing**

Add a small helper export to `ladybug.ts` (after `getPoolStats`):

```typescript
/**
 * Return all read pool connections. Used by the migration runner
 * to clear prepared statement caches after DDL changes.
 */
export function getReadPool(): readonly import("kuzu").Connection[] {
  return readPool;
}
```

- [ ] **Step 4: Verify build passes**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/db/ladybug.ts
git commit -m "feat(db): rewrite initLadybugDb to use migration runner"
```

---

### Task 6: Update the `formatReindexGuidanceError` message

**Files:**
- Modify: `src/db/ladybug.ts:36-43`

Now that in-place migration IS supported, the old error message ("Migrating older graph databases in-place is not supported") is misleading. Update it.

- [ ] **Step 1: Update the guidance message**

Replace:
```typescript
function formatReindexGuidanceError(dbPath: string, msg: string): string {
  return (
    `Database at '${dbPath}' is not compatible with the current graph engine (Ladybug). ` +
    `Delete the existing database directory and re-run indexing: rm -rf '${dbPath}' && sdl-mcp index. ` +
    "Migrating older graph databases in-place is not supported. " +
    `Original error: ${msg}`
  );
}
```
With:
```typescript
function formatReindexGuidanceError(dbPath: string, msg: string): string {
  return (
    `Database at '${dbPath}' could not be opened or initialized. ` +
    `If the database is corrupted, delete it and re-run indexing: rm -rf '${dbPath}' && sdl-mcp index. ` +
    `Original error: ${msg}`
  );
}
```

- [ ] **Step 2: Update the reindex guidance test expectations**

In `tests/unit/ladybug-reindex-guidance.test.ts`, the test at line 82-86 checks for the string "migrating older graph databases in-place is not supported". This assertion must be removed since we now do support migrations.

Remove the assertion block:
```typescript
        assert.ok(
          message.includes(
            "migrating older graph databases in-place is not supported",
          ),
          "error should state that migration is not supported",
        );
```

The remaining assertions (path context, delete/remove guidance, reindex/rebuild guidance) are still valid.

- [ ] **Step 3: Build and run the updated test**

Run: `cd sdl-mcp && npm run build:all && node --import tsx --test tests/unit/ladybug-reindex-guidance.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/db/ladybug.ts tests/unit/ladybug-reindex-guidance.test.ts
git commit -m "fix(db): update reindex guidance now that migrations are supported"
```

---

## Chunk 3: Doctor Integration + Final Tests

### Task 7: Update `doctor` command to show migration status

**Files:**
- Modify: `src/cli/commands/doctor.ts:544-620` (`checkLadybugDb` function)

- [ ] **Step 1: Add migration status to `checkLadybugDb`**

Add imports at the top of `doctor.ts` (after the existing `ladybug-schema` import):

```typescript
import {
  LADYBUG_SCHEMA_VERSION,
  migrations,
} from "../../db/migrations/index.js";
import { getSchemaVersion } from "../../db/ladybug-schema.js";
import { computePendingMigrations } from "../../db/migration-runner.js";
```

Remove `LADYBUG_SCHEMA_VERSION` from the existing `ladybug-schema` import (line 11):

Change:
```typescript
import {
  CALL_EDGE_METADATA_FIELDS,
  LADYBUG_SCHEMA_VERSION,
  supportsCallResolutionMetadata,
} from "../../db/ladybug-schema.js";
```
To:
```typescript
import {
  CALL_EDGE_METADATA_FIELDS,
  supportsCallResolutionMetadata,
} from "../../db/ladybug-schema.js";
```

Then in the `checkLadybugDb` function, after the edge count query (around line 603), add schema version reporting:

```typescript
    // Schema migration status
    let schemaInfo = "";
    try {
      const schemaVersion = await getSchemaVersion(conn);
      const dbVer = schemaVersion ?? 0;
      const pending = computePendingMigrations(migrations, dbVer);
      schemaInfo = `, schema: v${dbVer}/${LADYBUG_SCHEMA_VERSION}`;
      if (pending.length > 0) {
        schemaInfo += ` (${pending.length} pending migration${pending.length > 1 ? "s" : ""})`;
      }
    } catch {
      // Schema version query may fail on very old DBs; skip gracefully
    }
```

Then update the return message to include `schemaInfo`:

Change:
```typescript
      message: `Ladybug OK: ${ladybugDbPath}${pathInfo} (symbols: ${symbolCount}, edges: ${edgeCount})`,
```
To:
```typescript
      message: `Ladybug OK: ${ladybugDbPath}${pathInfo} (symbols: ${symbolCount}, edges: ${edgeCount}${schemaInfo})`,
```

- [ ] **Step 2: Verify `health.ts` still works**

`src/cli/commands/health.ts` imports `LADYBUG_SCHEMA_VERSION` from `../../db/ladybug-schema.js`. This continues to work via the re-export added in Task 2. No change needed — the re-export via `ladybug-schema.js` is the stable public API.

- [ ] **Step 3: Verify build passes**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/doctor.ts
git commit -m "feat(cli): show schema migration status in doctor command"
```

---

### Task 8: Integration test — fresh DB gets latest schema

**Files:**
- Create: `tests/unit/migration-fresh-db.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let getSchemaVersion: (conn: import("kuzu").Connection) => Promise<number | null>;
let LADYBUG_SCHEMA_VERSION: number;
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migMod = await import("../../dist/db/migrations/index.js");
  initLadybugDb = ladybugMod.initLadybugDb;
  closeLadybugDb = ladybugMod.closeLadybugDb;
  getLadybugConn = ladybugMod.getLadybugConn;
  getSchemaVersion = schemaMod.getSchemaVersion;
  LADYBUG_SCHEMA_VERSION = migMod.LADYBUG_SCHEMA_VERSION;
  ladybugAvailable = true;
} catch {
  // Module not built or kuzu unavailable
}

describe("migration: fresh database", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("fresh DB initializes at latest schema version", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "fresh.lbug");

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);

    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
  });
});
```

- [ ] **Step 2: Build and run test**

Run: `cd sdl-mcp && npm run build:all && node --import tsx --test tests/unit/migration-fresh-db.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/migration-fresh-db.test.ts
git commit -m "test(db): verify fresh DB initializes at latest schema version"
```

---

### Task 9: Integration test — migration upgrades existing DB

**Files:**
- Create: `tests/unit/migration-upgrade.test.ts`

- [ ] **Step 1: Write the test**

This test creates a DB at v4 (base schema without Memory tables), then verifies that `initLadybugDb` applies m005.

```typescript
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let getSchemaVersion: (conn: import("kuzu").Connection) => Promise<number | null>;
let LADYBUG_SCHEMA_VERSION: number;
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migMod = await import("../../dist/db/migrations/index.js");
  initLadybugDb = ladybugMod.initLadybugDb;
  closeLadybugDb = ladybugMod.closeLadybugDb;
  getLadybugConn = ladybugMod.getLadybugConn;
  getSchemaVersion = schemaMod.getSchemaVersion;
  LADYBUG_SCHEMA_VERSION = migMod.LADYBUG_SCHEMA_VERSION;
  ladybugAvailable = true;
} catch {
  // Module not built or kuzu unavailable
}

/**
 * Create a v4 database (base schema without Memory tables).
 * We open the DB, create the core tables + SchemaVersion at v4, then close.
 */
async function createV4Database(dbPath: string): Promise<void> {
  // Dynamic import to avoid top-level side effects
  const kuzu = await import("kuzu");
  const kuzuMod = (kuzu.default ?? kuzu) as typeof import("kuzu");

  const db = new kuzuMod.Database(dbPath);
  const conn = new kuzuMod.Connection(db);

  // Create minimal tables needed for a v4 DB
  const ddl = [
    `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
  ];
  for (const stmt of ddl) {
    const r = await conn.query(stmt);
    r.close();
  }

  // Stamp as v4
  const now = new Date().toISOString();
  const r = await conn.query(
    `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 4, createdAt: '${now}', updatedAt: '${now}'})`,
  );
  r.close();

  await conn.close();
  await db.close();
}

describe("migration: upgrade existing DB", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-upgrade-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("migrates v4 DB to latest version", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4.lbug");

    // Create a v4 database
    await createV4Database(dbPath);

    // Now init (should apply migrations)
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);

    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
    assert.ok(LADYBUG_SCHEMA_VERSION >= 5, "Version should be at least 5");
  });

  it("Memory table exists after migration", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4-memory.lbug");

    await createV4Database(dbPath);
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();

    // Query the Memory table — should not throw
    const result = await conn.query(
      "MATCH (m:Memory) RETURN count(m) AS cnt",
    );
    const rows = (await result.getAll()) as Array<{ cnt: unknown }>;
    result.close();

    // Empty but table exists
    assert.ok(rows.length > 0);
  });

  it("idempotent: re-init on already-migrated DB is a no-op", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4-idempotent.lbug");

    await createV4Database(dbPath);
    await initLadybugDb(dbPath);
    await closeLadybugDb();

    // Re-init on same DB — should not throw, should stay at same version
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);
    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
  });

  it("best-effort: DB newer than code logs warning but does not throw", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v-future.lbug");

    // Create a DB and stamp it with a version higher than code knows
    const kuzu = await import("kuzu");
    const kuzuMod = (kuzu.default ?? kuzu) as typeof import("kuzu");
    const db = new kuzuMod.Database(dbPath);
    const conn = new kuzuMod.Connection(db);

    const ddl = [
      `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
      `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
      `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
    ];
    for (const stmt of ddl) {
      const r = await conn.query(stmt);
      r.close();
    }
    const now = new Date().toISOString();
    const futureVersion = LADYBUG_SCHEMA_VERSION + 10;
    const r = await conn.query(
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: ${futureVersion}, createdAt: '${now}', updatedAt: '${now}'})`,
    );
    r.close();
    await conn.close();
    await db.close();

    // Should NOT throw — best-effort mode
    await assert.doesNotReject(async () => {
      await initLadybugDb(dbPath);
    });
  });
});
```

- [ ] **Step 2: Build and run test**

Run: `cd sdl-mcp && npm run build:all && node --import tsx --test tests/unit/migration-upgrade.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/migration-upgrade.test.ts
git commit -m "test(db): verify m005 migrates v4 DB to v5 with Memory tables"
```

---

### Task 10: Run full test suite and verify no regressions

**Files:** None (verification only)

- [ ] **Step 1: Build everything**

Run: `cd sdl-mcp && npm run build:all`
Expected: Clean build, no errors

- [ ] **Step 2: Run full test suite**

Run: `cd sdl-mcp && npm test`
Expected: All existing tests pass. The `ladybug-reindex-guidance.test.ts` test passes with updated assertions.

- [ ] **Step 3: Run typecheck**

Run: `cd sdl-mcp && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Final commit with all changes**

If any loose changes remain:
```bash
git add -A
git commit -m "chore: migration system cleanup"
```
