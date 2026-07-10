# SymbolEmbedding Forward Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unsafe legacy embedding deletion, remediate residual rows in already-upgraded databases, and prove the compatibility boundary without dropping persisted data or breaking the exported legacy writer.

**Architecture:** Put vector decoding, lane classification, transactional copy, and fingerprint-verified deletion in one unnumbered migration-support module. Harden migration 7 for databases that have not reached it and add migration 21 for versions 7–20; both call the same helper. Keep the compatibility table and exported writer, mark the writer deprecated, and leave physical/API removal for a later release gate.

**Tech Stack:** TypeScript 5.9, LadybugDB/Kuzu 0.16, parameterized Cypher, Node.js 24 built-in test runner.

---

Use `@sdl-mcp-agent-workflow` for indexed inspection and edits, `@test-driven-development` for each behavior, `@systematic-debugging` for any LadybugDB failure, `@test-scope` for focused suites, and `@verification-before-completion` before commits. A LadybugDB-focused reviewer must approve both the implementation diff and the fresh database-test evidence before this plan is closed.

## Chunk 1: Pure Remediation Core

### File responsibility map

- Create: `src/db/migrations/symbol-embedding-remediation.ts` — model-lane definitions, vector decoder/equality, row classification, transactional copy/deletion, deterministic summary logging.
- Modify: `src/db/ladybug-batching.ts:3-13` — add the existing 256-row policy under a semantically named `embeddingMigrations` batch kind.
- Create: `tests/unit/symbol-embedding-remediation.test.ts` — pure decoder, semantic equality, lane classification, null metadata, and defensive duplicate-query-result tests.

### Task 1: Define failing pure behavior tests

**Files:**
- Create: `tests/unit/symbol-embedding-remediation.test.ts`

- [ ] **Step 1: Add deterministic vector fixtures**

```typescript
const vector = (dimension: number, value = 0): number[] =>
  Array.from({ length: dimension }, () => value);

const encoded = (dimension: number, value = 0): string =>
  JSON.stringify(vector(dimension, value));
```

Import the planned `decodeStoredEmbeddingVector`, `storedEmbeddingVectorsEqual`, and `classifyLegacyEmbeddingRow` from `../../dist/db/migrations/symbol-embedding-remediation.js`.

- [ ] **Step 2: Test exact model dimensions and finite numeric values**

Cover:

- MiniLM accepts exactly 384 finite numbers.
- Nomic accepts exactly 768 finite numbers.
- One-short and one-long arrays return `null`.
- non-array JSON, malformed JSON, strings, booleans, and `null` return `null`.
- an array containing a non-number returns `null`.
- an array whose first number is `1e309` returns `null` because it parses as non-finite. Construct this fixture as raw JSON (for example, `"[1e309," + encoded(383).slice(1)`) because `JSON.stringify(1e309)` emits `null` and would not exercise the decoder boundary.

```typescript
assert.equal(
  decodeStoredEmbeddingVector(encoded(384), "all-MiniLM-L6-v2")?.length,
  384,
);
assert.equal(
  decodeStoredEmbeddingVector(encoded(768), "nomic-embed-text-v1.5")?.length,
  768,
);
assert.equal(
  decodeStoredEmbeddingVector(JSON.stringify(vector(383)), "all-MiniLM-L6-v2"),
  null,
);
```

- [ ] **Step 3: Test semantic vector equality**

Use full-dimension encodings with different whitespace/exponent spelling but equal values. Assert equality is elementwise `Object.is`, including `-0` versus `0`. Construct the negative-zero fixture as raw JSON (for example, `"[-0," + encoded(383).slice(1)`) because `JSON.stringify(-0)` normalizes it to `0`.

- [ ] **Step 4: Test the complete classification table**

Create row builders with all source fingerprint fields:

```typescript
interface LegacyEmbeddingFixture {
  symbolId: string | null;
  model: string | null;
  embeddingVector: string | null;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
```

Cover these decisions exactly:

- recognized + valid + all three destination fields null -> `copy`;
- recognized + valid + semantically equal vector and null-safe equal metadata -> `alreadyCurrent`;
- vector, hash, or timestamp conflict -> `retain/conflict`;
- destination vector null with non-null metadata -> `retain/conflict`, not empty;
- absent destination symbol -> `retain/orphan`;
- empty/null symbol id or invalid vector -> `retain/malformed`;
- `mock-fallback` -> `retain/mock`;
- unknown/null model -> `retain/unknownModel`;
- `findDuplicateSymbolIds(rows)` returns every non-empty id that appears more than once in the query result;
- each row whose id is in that batch-level set -> `retain/duplicateQueryResult` when passed to the singular classifier.

- [ ] **Step 5: Build and prove the red state**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts
```

Expected: FAIL because the support module and exports do not exist.

### Task 2: Implement the pure decoder, equality, and classifier

**Files:**
- Create: `src/db/migrations/symbol-embedding-remediation.ts`
- Modify: `src/db/ladybug-batching.ts:3-13`

- [ ] **Step 1: Extend the existing batch policy**

Add one fixed, documented entry without creating another batching abstraction:

```typescript
export const LADYBUG_WRITE_CHUNK_SIZES = {
  edges: 4096,
  symbolReferences: 4096,
  files: 4096,
  symbolVersions: 4096,
  symbols: 256,
  embeddingMigrations: 256,
} as const;
```

The remediation must call `resolveLadybugWriteChunkSize("embeddingMigrations")`.

- [ ] **Step 2: Define the compile-time model lanes**

```typescript
export type LegacyEmbeddingModel =
  | "all-MiniLM-L6-v2"
  | "nomic-embed-text-v1.5";

interface EmbeddingLane {
  model: LegacyEmbeddingModel;
  dimension: number;
  vectorProperty: "embeddingMiniLM" | "embeddingNomic";
  hashProperty: "embeddingMiniLMCardHash" | "embeddingNomicCardHash";
  updatedAtProperty: "embeddingMiniLMUpdatedAt" | "embeddingNomicUpdatedAt";
}

const LANES: Readonly<Record<LegacyEmbeddingModel, EmbeddingLane>> = {
  "all-MiniLM-L6-v2": {
    model: "all-MiniLM-L6-v2",
    dimension: 384,
    vectorProperty: "embeddingMiniLM",
    hashProperty: "embeddingMiniLMCardHash",
    updatedAtProperty: "embeddingMiniLMUpdatedAt",
  },
  "nomic-embed-text-v1.5": {
    model: "nomic-embed-text-v1.5",
    dimension: 768,
    vectorProperty: "embeddingNomic",
    hashProperty: "embeddingNomicCardHash",
    updatedAtProperty: "embeddingNomicUpdatedAt",
  },
};
```

Only these compile-time identifiers may be interpolated as Cypher property names. Every row value remains parameterized.

- [ ] **Step 3: Implement the production decoder**

```typescript
export function decodeStoredEmbeddingVector(
  raw: string | null,
  model: LegacyEmbeddingModel,
): number[] | null {
  if (typeof raw !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const dimension = LANES[model].dimension;
  if (
    !Array.isArray(parsed)
    || parsed.length !== dimension
    || !parsed.every(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
  ) {
    return null;
  }
  return parsed;
}
```

- [ ] **Step 4: Implement semantic equality without reserialization**

```typescript
export function storedEmbeddingVectorsEqual(
  left: string | null,
  right: string | null,
  model: LegacyEmbeddingModel,
): boolean {
  const decodedLeft = decodeStoredEmbeddingVector(left, model);
  const decodedRight = decodeStoredEmbeddingVector(right, model);
  return decodedLeft !== null
    && decodedRight !== null
    && decodedLeft.every((value, index) =>
      Object.is(value, decodedRight[index]));
}
```

Use `(left ?? null) === (right ?? null)` for hash/timestamp equality. Never rewrite a valid source vector string.

- [ ] **Step 5: Implement explicit fingerprints and decisions**

Define source and destination fingerprints containing every field required by the spec:

```typescript
export interface LegacyEmbeddingFingerprint {
  symbolId: string;
  model: LegacyEmbeddingModel;
  embeddingVector: string;
  version: string | null;
  cardHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DestinationEmbeddingFingerprint {
  symbolId: string;
  vector: string | null;
  cardHash: string | null;
  updatedAt: string | null;
}

export function findDuplicateSymbolIds(
  rows: readonly { symbolId: string | null }[],
): ReadonlySet<string> {
  // Count first, then return only ids that cannot be classified safely in isolation.
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.symbolId) counts.set(row.symbolId, (counts.get(row.symbolId) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([symbolId]) => symbolId),
  );
}

export type RemediationDecision =
  | { kind: "copy"; source: LegacyEmbeddingFingerprint; destination: DestinationEmbeddingFingerprint }
  | { kind: "alreadyCurrent"; source: LegacyEmbeddingFingerprint; destination: DestinationEmbeddingFingerprint }
  | { kind: "retain"; reason: "conflict" | "orphan" | "malformed" | "mock" | "unknownModel" | "duplicateQueryResult" };
```

`classifyLegacyEmbeddingRow` must implement the complete test table and accept the batch-level duplicate-id set (or an explicit `isDuplicate` boolean) produced before any singular row classification. Treat a lane as empty only when vector, hash, and timestamp are all null.

- [ ] **Step 6: Build and run the pure tests**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts
```

Expected: all decoder/equality/classification tests pass.

- [ ] **Step 7: Commit the pure core**

```powershell
git add src/db/ladybug-batching.ts src/db/migrations/symbol-embedding-remediation.ts tests/unit/symbol-embedding-remediation.test.ts
git commit -m "feat(db): add safe embedding remediation core"
```

## Chunk 2: Transactional Copy, Delete, and Migration Wiring

### File responsibility map

- Modify: `src/db/migrations/symbol-embedding-remediation.ts` — add database orchestration to the pure core.
- Modify: `src/db/migrations/m007-copy-embeddings-to-symbol.ts:1-196` — retain idempotent DDL, replace broad copy/delete logic with the shared helper.
- Create: `src/db/migrations/m021-remediate-symbol-embeddings.ts` — forward remediation for recorded schema versions 7–20.
- Modify: `src/db/migrations/index.ts:10-46` — register migration 21; latest schema version derives as 21.
- Create: `tests/unit/migration-symbol-embedding-remediation.test.ts` — focused real-LadybugDB migration, rollback, mutation, and version-path coverage.
- Modify: `tests/unit/migration-fresh-db.test.ts:43-52` — prove direct latest-schema creation at version 21.

### Task 3: Write failing LadybugDB behavior tests

**Files:**
- Create: `tests/unit/migration-symbol-embedding-remediation.test.ts`
- Modify: `tests/unit/migration-fresh-db.test.ts:43-52`

- [ ] **Step 1: Create isolated real-database helpers**

Follow the existing `migration-fresh-db.test.ts` lifecycle: a unique path under `tmpdir()`, `afterEach` close, and recursive cleanup. Add helpers that:

- create a minimal pre-v7 `Symbol` table with only some destination columns;
- create the compatibility `SymbolEmbedding` table with `symbolId` as its primary key;
- seed source rows with all seven fingerprint fields;
- seed destination symbols;
- read source/destination rows through `queryAll`;
- generate 384/768-element JSON vectors.

Run every real-LadybugDB command in this plan through SDL `runtimeExecute` with `env: { SDL_MCP_DISABLE_NATIVE_ADDON: "1" }` and include `--test-concurrency=1`. Do not mutate the parent process environment; this keeps the focused database tests serial and forces the TypeScript fallback only in the child command.

- [ ] **Step 2: Prove the physical identity**

On a real database, call the compatibility writer twice for one `symbolId` with different models and assert exactly one row remains and the model is updated. Also attempt a direct duplicate `CREATE` and assert the primary-key violation. Do not create impossible duplicate migration fixtures.

- [ ] **Step 3: Test hardened migration 7 and partial DDL**

Build a minimal v6-style database with three MiniLM destination columns already present and all Nomic columns absent. Seed:

- valid MiniLM empty lane;
- valid Nomic empty lane;
- semantic exact match with null metadata;
- destination conflict;
- orphan;
- malformed vector;
- mock model;
- unknown model.

Call `m007.up(conn)`. Assert valid/identical rows are removed only after destination verification, while conflict/orphan/malformed/mock/unknown rows remain. Rerun `m007.up(conn)` and assert idempotent results.

- [ ] **Step 4: Test the version paths**

Assert registry behavior:

```typescript
assert.equal(LADYBUG_SCHEMA_VERSION, 21);
assert.deepEqual(
  computePendingMigrations(migrations, 20).map(({ version }) => version),
  [21],
);
assert.deepEqual(
  computePendingMigrations(migrations, 7).map(({ version }) => version),
  Array.from({ length: 14 }, (_, index) => index + 8),
);
```

Exercise both recorded upgrade boundaries through the real initializer:

- For a latest-schema fixture whose `SchemaVersion` row is reset to 20 and contains residual compatibility rows, close and call `initLadybugDb`; assert migration 21 runs and records version 21.
- For a latest-schema fixture whose `SchemaVersion` row is reset to 7, temporarily wrap exported registry entries 8 through 21 with recording delegates, close, and call `initLadybugDb`. Assert the real runner invokes versions 8–21 in order, reaches version 21, and produces safe residual-row state. Restore every registry entry in `finally`.

- [ ] **Step 5: Test direct fresh-schema and future-version behavior**

Extend `migration-fresh-db.test.ts` to assert:

- schema version is exactly 21;
- a `Symbol` can be created/read using all MiniLM and Nomic STRING/hash/timestamp properties;
- querying the empty `SymbolEmbedding` table succeeds;
- no numbered migration hook is invoked for a fresh DB: temporarily replace one exported `migrations` entry with a same-version wrapper whose `up` throws, initialize a brand-new database, and restore the original entry in `finally`. The direct latest-schema path must still succeed.

In the focused migration test, set a created database's version to 22, reopen it, and assert initialization continues without running pending migrations and preserves version 22. The existing initializer warning is preserved; do not add a rejection policy.

- [ ] **Step 6: Build and prove the red state**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-runner.test.ts
```

Expected: FAIL because m021, registry version 21, and transactional remediation are not implemented.

### Task 4: Implement the transactional remediation helper

**Files:**
- Modify: `src/db/migrations/symbol-embedding-remediation.ts`

- [ ] **Step 1: Read and classify inside the copy transaction**

`remediateSymbolEmbeddings(conn, migrationLabel)` must enter `withTransaction` before reading source rows. Within that callback:

1. Query compatibility rows with aliases for `symbolId`, `model`, `embeddingVector`, `version`, `cardHash`, `createdAt`, and `updatedAt`.
2. Use `ORDER BY se.symbolId, se.model`.
3. Batch-read all destination lane properties with parameterized ids.
4. Run `findDuplicateSymbolIds` over the complete ordered result before singular classification.
5. Classify current source and destination fingerprints.
6. Execute conditional copy queries and collect only rows actually returned by the query.

Let a missing-table query error escape the callback so `withTransaction` rolls back. Catch it only outside the completed `withTransaction` call, and return an idempotent empty summary only for the two existing table-not-found messages. Never catch it inside the transaction callback. No read performed before `withTransaction` may authorize a write.

- [ ] **Step 2: Build conditional copy queries from compile-time lane identifiers**

Use a query builder whose lane argument is only one of the two module constants. The generated query must parameterize every value and revalidate:

```cypher
UNWIND $rows AS r
MATCH (se:SymbolEmbedding {symbolId: r.symbolId})
MATCH (s:Symbol {symbolId: r.symbolId})
WHERE se.model = r.model
  AND se.embeddingVector = r.embeddingVector
  AND ((se.version = r.version) OR (se.version IS NULL AND r.version IS NULL))
  AND ((se.cardHash = r.cardHash) OR (se.cardHash IS NULL AND r.cardHash IS NULL))
  AND ((se.createdAt = r.createdAt) OR (se.createdAt IS NULL AND r.createdAt IS NULL))
  AND ((se.updatedAt = r.updatedAt) OR (se.updatedAt IS NULL AND r.updatedAt IS NULL))
  AND s.<vectorProperty> IS NULL
  AND s.<hashProperty> IS NULL
  AND s.<updatedAtProperty> IS NULL
SET s.<vectorProperty> = r.embeddingVector,
    s.<hashProperty> = r.cardHash,
    s.<updatedAtProperty> = r.updatedAt
RETURN r.symbolId AS symbolId,
       s.<vectorProperty> AS vector,
       s.<hashProperty> AS cardHash,
       s.<updatedAtProperty> AS updatedAt
ORDER BY symbolId
```

The angle-bracket identifiers above are substituted only from `LANES`; do not interpolate row values. Chunk with `resolveLadybugWriteChunkSize("embeddingMigrations")`.

- [ ] **Step 3: Commit copy before deletion**

Build deletion candidates from:

- rows returned by conditional copy queries; and
- `alreadyCurrent` rows whose destination fingerprint was observed in the same transaction.

If a copy query throws, let `withTransaction` roll back and do not enter deletion.

- [ ] **Step 4: Revalidate and delete in a second transaction**

For each bounded batch, first use `queryAll` to select rows whose complete source and destination raw fingerprints still match. Use explicit null-safe predicates for nullable `version`, `cardHash`, `createdAt`, and timestamps. The destination vector comparison in this phase is raw-string equality to the exact observed fingerprint; semantic equality was already established during classification.

Inside the same deletion transaction, delete only the verified fingerprints using a parameterized `UNWIND` query with the same complete predicates. Report deletion from the verified result set, never from a successful `exec` alone.

- [ ] **Step 5: Return and log a deterministic summary**

Return counts for scanned, copied, already-current, deleted, and each retain reason. Sort any model/reason entries before logging. Do not include timestamps, durations, absolute paths, or source vectors in the summary.

### Task 5: Wire hardened m007 and new m021

**Files:**
- Modify: `src/db/migrations/m007-copy-embeddings-to-symbol.ts:1-196`
- Create: `src/db/migrations/m021-remediate-symbol-embeddings.ts`
- Modify: `src/db/migrations/index.ts:10-46`

- [ ] **Step 1: Keep only m007's idempotent DDL plus shared-helper call**

Retain the six destination-column `ALTER TABLE` statements and `IDEMPOTENT_DDL_ERROR_RE` handling. Remove the old broad source query, unconditional SET loops, and `DELETE` by `symbolId`. End with:

```typescript
await remediateSymbolEmbeddings(conn, "m007");
```

Update the file comment to describe conservative copy/delete semantics rather than unconditional recognized-model deletion.

- [ ] **Step 2: Add migration 21**

```typescript
import type { Connection } from "kuzu";

import { remediateSymbolEmbeddings } from "./symbol-embedding-remediation.js";

export const version = 21;
export const description =
  "Safely remediate residual SymbolEmbedding compatibility rows";

export async function up(conn: Connection): Promise<void> {
  await remediateSymbolEmbeddings(conn, "m021");
}
```

- [ ] **Step 3: Register m021 after m020**

Import `m021`, append it to the ordered registry, and leave `LADYBUG_SCHEMA_VERSION` derived from the final registry entry.

- [ ] **Step 4: Build and run the focused tests**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/migration-runner.test.ts
```

Expected: pure behavior, pre-v7 m007, real initializer paths from recorded versions 7 and 20, m021 remediation, fresh v21 creation, future-version best effort, and upgrade regressions all pass.

- [ ] **Step 5: Check staging and commit the migration wiring checkpoint**

```powershell
git diff --cached --name-only
git add src/db/migrations src/db/ladybug-batching.ts tests/unit/symbol-embedding-remediation.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/migration-fresh-db.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(db): wire safe embedding remediation migrations"
```

The first staged-file listing must be empty (or contain only files explicitly owned by this task); the second must match the paths above. Stop if unrelated user changes are staged.

## Chunk 3: Failure Injection, Race Revalidation, and API Gate

### File responsibility map

- Modify: `tests/unit/migration-symbol-embedding-remediation.test.ts` — prepared-query interception, rollback, between-phase mutation, idempotent retry, deterministic batching.
- Modify: `src/db/ladybug-embeddings.ts:31-37` — deprecate but retain the compatibility writer.
- Modify: `src/db/ladybug-queries.ts:59-63` — label the old module as compatibility-only without removing the barrel.
- Modify: `tests/unit/ladybug-embeddings-queries.test.ts` and `tests/unit/ladybug-auxiliary-queries.test.ts` only as needed to assert compatibility remains intact.

### Task 6: Add failure and mutation tests before changing behavior

**Files:**
- Modify: `tests/unit/migration-symbol-embedding-remediation.test.ts`

- [ ] **Step 1: Add a connection interception helper**

Create a test-only `Proxy` around a real `Connection`. Bind native methods to the real connection, map prepared statements to their SQL in the `prepare` trap, and allow one-shot `beforeExecute`/`afterExecute` callbacks keyed by stable SQL substrings. Do not add production fault-injection hooks.

- [ ] **Step 2: Test copy rollback**

Intercept the first conditional copy statement and throw a sentinel error. Assert:

- remediation rejects;
- every destination lane remains unchanged;
- every source row remains;
- no deletion statement ran.

- [ ] **Step 3: Test the missing-table rollback boundary**

Run remediation against a real database with no `SymbolEmbedding` table. Capture transaction statements through the proxy and assert the source query error escapes the callback, `ROLLBACK` completes, and only then the helper returns the deterministic empty summary. A different query error must still reject.

- [ ] **Step 4: Test copy-fingerprint revalidation**

Immediately before the conditional `SET`, mutate the destination lane through the underlying real connection while the same transaction is active. The conditional query must return no copied row, preserve the injected destination, and leave the source row. Repeat for a changed source fingerprint, again routing the mutation through the real connection rather than the proxy.

- [ ] **Step 5: Test between-phase deletion revalidation**

Inject through the underlying real connection immediately before the helper issues the deletion phase's second `BEGIN` (after the copy transaction has committed). Mutate first the source and then the destination in separate cases. Assert the changed row remains in `SymbolEmbedding`. This hook must target the between-phase boundary, not an after-`COMMIT` callback whose timing can race the next transaction.

- [ ] **Step 6: Test deletion failure and rerun**

Throw on the first SQL statement containing `DELETE se`. Assert destination copy committed, source remains, and remediation rejects. Restore the connection and rerun; assert it classifies the destination as already current and deletes safely.

- [ ] **Step 7: Test final SchemaVersion-write failure and rerun**

Call `runPendingMigrations(conn, 20, [wrappedM021])`, where the wrapper's `up` delegates to `m021.up`; intercept only the runner's final `MERGE (sv:SchemaVersion` and throw. Assert copied destination state is safe whether the source row was retained or already deleted, recreate or preserve only the version-20 marker as needed, then retry through `runPendingMigrations(conn, 20, [m021])` (never by calling `m021.up` directly). The retry must safely empty-noop or finish deletion and record version 21.

- [ ] **Step 8: Test deterministic multi-batch behavior**

Seed 257 valid rows in each model lane. Capture `rows` parameters and categorize every prepared execution as source-read, destination-read, MiniLM-copy, Nomic-copy, MiniLM-delete-verify, MiniLM-delete, Nomic-delete-verify, or Nomic-delete. Assert:

- each lane-specific copy, delete-verify, and delete category executes exactly `Math.ceil(laneCandidateCount / 256)` times;
- destination reads execute exactly `Math.ceil(uniqueSymbolCount / 256)` times and the ordered source read executes once;
- ids are sorted within and across every category;
- no write category grows with individual rows;
- the final destination/source state and category counts are deterministic across a clean rerun.

- [ ] **Step 9: Run the failure-focused red/green loop**

Run after each test is added and again after the minimal implementation adjustment:

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/migration-symbol-embedding-remediation.test.ts
```

Expected final result: all rollback, stale-fingerprint, between-phase, retry, and batching tests pass.

### Task 7: Preserve and deprecate the legacy writer

**Files:**
- Modify: `src/db/ladybug-embeddings.ts:31-37`
- Modify: `src/db/ladybug-queries.ts:59-63`
- Verify: `tests/unit/ladybug-embeddings-queries.test.ts`
- Verify: `tests/unit/ladybug-auxiliary-queries.test.ts`

- [ ] **Step 1: Re-run the indexed caller/export gate**

Use SDL symbol search/card/slice for `upsertSymbolEmbedding`. Confirm the current evidence remains:

- no production caller;
- compatibility tests call it;
- `ladybug-queries.ts` exports the containing module;
- the package ships `dist/` and does not declare an exports map.

Because the writer remains externally reachable, do not remove or unexport it in this batch.

- [ ] **Step 2: Add a precise deprecation comment**

```typescript
/**
 * @deprecated Compatibility-only writer for legacy SymbolEmbedding rows.
 * New production writes must use the model-aware Symbol node embedding helpers
 * in ladybug-symbol-embeddings.ts. Keep this export until the compatibility
 * table is removed at an authorized release boundary.
 */
export async function upsertSymbolEmbedding(
  conn: Connection,
  row: SymbolEmbeddingRow,
): Promise<void> {
  // existing implementation remains unchanged
}
```

Update the barrel comment to say “Legacy SymbolEmbedding compatibility CRUD, summary cache, sync artifacts, and symbol references.”

- [ ] **Step 3: Run compatibility and static gates**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/ladybug-embeddings-queries.test.ts tests/unit/ladybug-auxiliary-queries.test.ts
npm run typecheck
npm run lint
```

Expected: all compatibility tests pass; typecheck/lint exit 0 with no new warnings or errors.

- [ ] **Step 4: Commit compatibility deprecation and failure proof**

```powershell
git diff --cached --name-only
git add src/db/ladybug-embeddings.ts src/db/ladybug-queries.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/ladybug-embeddings-queries.test.ts tests/unit/ladybug-auxiliary-queries.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "test(db): prove safe embedding remediation failures"
```

Stop if the first staged-file listing is not empty or the second contains a path outside this step.

### Task 8: Complete the LadybugDB review gate

- [ ] **Step 1: Run the complete focused database set**

```powershell
npm run build
node --test --test-concurrency=1 tests/unit/symbol-embedding-remediation.test.ts tests/unit/migration-symbol-embedding-remediation.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/migration-runner.test.ts tests/unit/ladybug-embeddings-queries.test.ts tests/unit/ladybug-auxiliary-queries.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0. The cross-track integration plan owns the later full `npm test` gate; retain and hand off this focused run's persisted runtime handles so the full-suite result can be correlated without rerunning the focused set.

- [ ] **Step 2: Dispatch the LadybugDB-focused change reviewer**

Provide only the design spec, this plan, the database diff, and fresh artifact handles. Require explicit review of:

- m007/m021 version paths;
- direct fresh-v21 behavior and >21 best effort;
- copy/deletion transaction boundaries;
- full nullable fingerprints;
- conditional write/delete query semantics;
- rollback and schema-version retry tests;
- real physical identity;
- no table drop or unsupported export removal.

- [ ] **Step 3: Address every blocking review finding with another red-green loop**

Do not weaken a test or delete a compatibility row to make the review pass. Re-run the focused set after every correction.

- [ ] **Step 4: Record deferred work without closing it**

The final backlog reconciliation must leave both physical `SymbolEmbedding` removal and removal of the deprecated writer unchecked until persisted databases are validated across an authorized release boundary.
