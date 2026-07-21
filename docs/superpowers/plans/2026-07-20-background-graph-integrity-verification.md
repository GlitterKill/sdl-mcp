# Background Graph Integrity Verification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this plan. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make saved symbol edits commit quickly while an application-owned worker independently verifies the latest persisted graph revision in the background.

**Architecture:** Persist independently constructed per-file and fileless expectations beside the graph, advance a monotonic revision in the same LadybugDB transaction as each graph mutation, and verify the newest revision on one explicit read-only snapshot. Publish through a Version-and-revision CAS; keep graph reads available during verifying or failed states without claiming that the latest revision is verified.

**Tech Stack:** TypeScript, Node.js 24, node:test, LadybugDB 0.18.1, existing SDL-MCP live-index, provider-first, shadow-activation, and benchmark infrastructure.

---

## Approved constraints

- Reuse existing canonical digest, fileless sentinel, liveness ledger, bounded diagnostics, repository lock, retry, shutdown, and shadow-handoff primitives.
- Do not add a stored procedure, native extension, public configuration flag, shadow read graph, automatic reindex, or per-edit PageRank/derived-state refresh.
- Use GraphIntegrityFileState and GraphIntegrityFilelessState node tables plus manifest-to-Repo relationship tables. LadybugDB 0.18.1 cannot create custom-property indexes.
- Use JSON.stringify([repoId, identity]) for collision-free state IDs.
- Keep full and ordinary incremental indexing synchronously verified. Only saved-file patches move full-graph verification out of the foreground.
- Add concise comments only at the independence boundary, transaction/CAS boundary, read-snapshot lifecycle, and cancellation handoff.
- Each task follows TDD: add a focused failing test, run it and confirm the expected failure, add the minimum implementation, run focused tests, then commit.

## File structure

New files:

- src/db/migrations/m023-add-graph-integrity-revisions-and-manifest.ts — idempotent migration for revisions, pruning support, manifest nodes, and repository relationships.
- src/indexer/provider-first/background-graph-integrity-verifier.ts — one per-repository coalescing verifier registry, recovery sweep, cancellation, and CAS publication.
- tests/unit/ladybug-derived-state-revisions.test.ts — nullable revisions, predicates, and Version-and-revision CAS behavior.
- tests/unit/ladybug-graph-integrity-manifest.test.ts — deterministic manifest encoding and query behavior.
- tests/unit/background-graph-integrity-verifier.test.ts — coalescing, stale CAS, retry, recovery, and cancellation behavior.
- tests/integration/background-graph-integrity-snapshot.test.ts — real Ladybug read-only snapshot and writer concurrency behavior.
- scripts/background-graph-integrity-benchmark.ts — deterministic candidate/control benchmark and artifact writer.

Primary modified files:

- src/db/ladybug-schema.ts
- src/db/migrations/index.ts
- src/db/ladybug-derived-state.ts
- src/db/ladybug-graph-integrity.ts
- src/db/ladybug-queries.ts
- src/db/ladybug-core.ts
- src/db/ladybug.ts
- src/live-index/file-patcher.ts
- src/indexer/provider-first/persisted-graph-integrity.ts
- src/indexer/indexer.ts
- src/indexer/provider-first/shadow-activation.ts
- src/db/ladybug-shadow-finalization.ts
- src/db/ladybug-repos.ts
- src/services/repo-lifecycle.ts
- src/startup/derived-state-recovery.ts
- src/mcp/tools/repo.ts
- src/mcp/tools.ts
- src/mcp/context-response-projection.ts
- src/services/health.ts
- src/sync/sync.ts
- src/main.ts
- src/cli/commands/serve.ts
- tests/integration/determinism.fixtures.json
- package.json
- .github/workflows/ci.yml
- CHANGELOG.md
- docs/symbol-edit-tool.md
- docs/mcp-tools-reference.md
- docs/mcp-tools-reference-detailed.md
- docs/architecture.md
- docs/prompt-cache-hygiene.md
- SDL.md

## Chunk 1: Persistence and transaction primitives

### Task 1: Add revision-aware derived state and migration m023

**Files:**

- Create: src/db/migrations/m023-add-graph-integrity-revisions-and-manifest.ts
- Modify: src/db/ladybug-schema.ts
- Modify: src/db/migrations/index.ts
- Modify: src/db/ladybug-derived-state.ts
- Modify: src/db/ladybug-queries.ts
- Test: tests/unit/migration-graph-integrity.test.ts
- Test: tests/unit/migration-fresh-db.test.ts
- Test: tests/unit/migration-upgrade.test.ts
- Create: tests/unit/ladybug-derived-state-revisions.test.ts

- [ ] **Step 1: Write failing migration and revision-state tests**

Cover fresh schema, m022-to-m023 upgrade, rerun after partial DDL, and two repositories. Assert:

- Both nullable revision fields and graphIntegrityFilelessPruningSupported exist.
- Existing rows migrate to graphIntegrityState = unknown with all three new fields null.
- Old Version, digest, and diagnostic history remain stored but cannot satisfy the verified predicate.
- Both manifest node tables and both manifest-to-Repo relationship tables exist.
- No custom-property CREATE INDEX statement is attempted.

Add predicate/CAS tests for null versus zero, bigint conversion, safe-integer rejection, wrong state, wrong Version, wrong revision, and digest preservation.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/migration-graph-integrity.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/ladybug-derived-state-revisions.test.ts
~~~

Expected: FAIL because m023, new fields, and revision-aware helpers do not exist.

- [ ] **Step 3: Add the idempotent schema and migration**

Add nullable properties:

~~~text
graphIntegrityRevision INT64
graphIntegrityVerifiedRevision INT64
graphIntegrityFilelessPruningSupported BOOLEAN
~~~

Add node tables:

~~~text
GraphIntegrityFileState(stateId PRIMARY KEY, repoId, fileId, relPath, symbolCount, digest, filelessReferencesJson)
GraphIntegrityFilelessState(stateId PRIMARY KEY, repoId, symbolId, canonicalSymbolJson, referenceCount)
~~~

Add relationship tables:

~~~text
GRAPH_INTEGRITY_FILE_STATE_IN_REPO(FROM GraphIntegrityFileState TO Repo)
GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO(FROM GraphIntegrityFilelessState TO Repo)
~~~

Follow src/db/migrations/m022-add-graph-integrity-state.ts error handling so every DDL statement tolerates a rerun after partial completion. Register m023 and let LADYBUG_SCHEMA_VERSION derive from the registry.

- [ ] **Step 4: Add minimal revision APIs**

Extend DerivedStateRow and DerivedStateSummary. Convert nullable INT64 values only after a null check.

Own and export these contracts from src/db/ladybug-derived-state.ts, importing Connection from kuzu:

~~~ts
export interface GraphIntegrityPendingRevision {
  repoId: string;
  versionId: string;
  revision: number;
  verifiedRevision: number | null;
}

export function beginGraphIntegrityVersion(
  conn: Connection,
  repoId: string,
  versionId: string,
  digest: string,
  pruningSupported: boolean,
): Promise<void>;

export function advanceGraphIntegrityRevisionInTransaction(
  conn: Connection,
  repoId: string,
  versionId: string,
  expectedRevision: number,
): Promise<number | null>;

export function markGraphIntegrityVerifiedIfVerifying(
  repoId: string,
  versionId: string,
  revision: number,
  digest: string,
): Promise<boolean>;

export function markGraphIntegrityFailedIfVerifying(
  repoId: string,
  versionId: string,
  revision: number,
  error: string,
): Promise<boolean>;

export function markCurrentGraphIntegrityRevisionFailed(
  repoId: string,
  versionId: string,
  revision: number,
  error: string,
): Promise<boolean>;

export function listPendingGraphIntegrityRevisions(): Promise<
  GraphIntegrityPendingRevision[]
>;

export function graphIntegrityIsVerifiedForVersion(
  row: DerivedStateRow | null,
  versionId: string | null,
): boolean;

export function graphIntegrityIsAvailableForVersion(
  row: DerivedStateRow | null,
  versionId: string | null,
): boolean;
~~~

beginGraphIntegrityVersion runs inside the owning full-index transaction and publishes the new Version as verified with graphIntegrityRevision = 0, graphIntegrityVerifiedRevision = 0, the supplied digest, pruning support, and a cleared error. The transaction-bound advance requires the exact current Version/revision, returns the new revision, or returns null without mutation when stale; it preserves the prior verified revision and digest. Each publication/failure CAS returns true only when it changed the exact current row and false when stale. Success and worker failure require state = verifying plus exact Version and revision. Direct failure requires exact Version and current revision. Failure never advances or clears the verified revision/digest. Pending rows are returned in deterministic repoId order. Availability is true only for the exact Version when state is verified, verifying, or failed and revision plus pruning-support fields are non-null; it is false for unknown, null row/version, or Version mismatch. Latest-verified additionally requires verified state, equal non-null current/verified revisions, and a valid digest.

- [ ] **Step 5: Run focused tests, typecheck, and lint touched source**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/migration-graph-integrity.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/ladybug-derived-state-revisions.test.ts
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add src/db/ladybug-schema.ts src/db/migrations/m023-add-graph-integrity-revisions-and-manifest.ts src/db/migrations/index.ts src/db/ladybug-derived-state.ts src/db/ladybug-queries.ts tests/unit/migration-graph-integrity.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-upgrade.test.ts tests/unit/ladybug-derived-state-revisions.test.ts
git commit -m "Add graph integrity revisions and manifest schema"
~~~

### Task 2: Persist deterministic file and fileless manifests

**Files:**

- Modify: src/db/ladybug-graph-integrity.ts
- Modify: src/db/ladybug-queries.ts
- Modify: src/indexer/provider-first/persisted-graph-integrity.ts
- Create: tests/unit/ladybug-graph-integrity-manifest.test.ts
- Modify: tests/unit/persisted-graph-integrity.test.ts

- [ ] **Step 1: Write failing manifest tests**

Cover:

- JSON tuple state IDs remain distinct for adversarial repo/file strings.
- filelessReferencesJson is a sorted six-field tuple array in this exact order: fileless symbol ID, independently constructed canonicalSymbolJson, nullable source symbol ID, edge type, direction, and count.
- canonicalSymbolJson uses existing appendCanonicalSymbol field order and rejects malformed persisted JSON.
- Exact state lookup verifies repoId and fileId/symbolId after primary-key lookup.
- Repo reads traverse the relationship tables and order files by relPath, fileId and fileless rows by symbolId.
- Upsert, delete, replace-all, rollback, and two-repo isolation work.
- Zero-liveness pruning occurs only when graphIntegrityFilelessPruningSupported is true.

- [ ] **Step 2: Run tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-graph-integrity-manifest.test.ts tests/unit/persisted-graph-integrity.test.ts
~~~

Expected: FAIL because manifest types and queries do not exist.

- [ ] **Step 3: Add the minimum manifest API**

Own these record types and query contracts in src/db/ladybug-graph-integrity.ts and export them through src/db/ladybug-queries.ts:

~~~ts
export interface GraphIntegrityFileStateRecord {
  stateId: string;
  repoId: string;
  fileId: string;
  relPath: string;
  symbolCount: number;
  digest: string;
  filelessReferencesJson: string;
}

export interface GraphIntegrityFilelessStateRecord {
  stateId: string;
  repoId: string;
  symbolId: string;
  canonicalSymbolJson: string;
  referenceCount: number;
}

export interface GraphIntegrityManifest {
  files: readonly GraphIntegrityFileStateRecord[];
  fileless: readonly GraphIntegrityFilelessStateRecord[];
}

export interface GraphIntegrityFilelessDelta {
  upserts: readonly GraphIntegrityFilelessStateRecord[];
  deleteSymbolIds: readonly string[];
}

export function getGraphIntegrityFileState(
  conn: Connection,
  repoId: string,
  fileId: string,
): Promise<GraphIntegrityFileStateRecord | null>;

export function upsertGraphIntegrityFileStateInTransaction(
  conn: Connection,
  row: GraphIntegrityFileStateRecord,
): Promise<void>;

export function deleteGraphIntegrityFileStateInTransaction(
  conn: Connection,
  repoId: string,
  fileId: string,
): Promise<void>;

export function listGraphIntegrityFileStates(
  conn: Connection,
  repoId: string,
): Promise<GraphIntegrityFileStateRecord[]>;

export function upsertGraphIntegrityFilelessStateInTransaction(
  conn: Connection,
  row: GraphIntegrityFilelessStateRecord,
): Promise<void>;

export function deleteGraphIntegrityFilelessStateInTransaction(
  conn: Connection,
  repoId: string,
  symbolId: string,
): Promise<void>;

export function listGraphIntegrityFilelessStates(
  conn: Connection,
  repoId: string,
): Promise<GraphIntegrityFilelessStateRecord[]>;

export function replaceGraphIntegrityManifestInTransaction(
  conn: Connection,
  repoId: string,
  manifest: GraphIntegrityManifest,
): Promise<void>;

export function deleteGraphIntegrityManifestInTransaction(
  conn: Connection,
  repoId: string,
): Promise<void>;
~~~

Use MERGE for nodes and relationships, parameterized values, deterministic ORDER BY, and toNumber for counts. Build stateId with JSON.stringify([repoId, fileId]) or JSON.stringify([repoId, symbolId]). Exact lookups must recheck repoId and identity after the primary-key match. Batch full replacements with UNWIND but do not trust side-effect row counts.

- [ ] **Step 4: Expose reusable expectation codecs**

Extract only the reusable canonical helpers needed by both synchronous index verification and the worker:

~~~ts
export type GraphIntegrityFilelessReferenceTuple = readonly [
  filelessSymbolId: string,
  canonicalSymbolJson: string,
  sourceSymbolId: string | null,
  edgeType: string,
  direction: "incoming" | "outgoing",
  referenceCount: number,
];

export function createGraphIntegrityFileState(
  repoId: string,
  fileId: string,
  relPath: string,
  symbols: readonly GraphIntegrityCanonicalSymbol[],
  filelessReferences: readonly GraphIntegrityFilelessReferenceTuple[],
): GraphIntegrityFileStateRecord;

export function createGraphIntegrityFilelessDelta(
  repoId: string,
  current: ReadonlyMap<string, GraphIntegrityFilelessStateRecord>,
  previous: readonly GraphIntegrityFilelessReferenceTuple[],
  next: readonly GraphIntegrityFilelessReferenceTuple[],
  pruningSupported: boolean,
): GraphIntegrityFilelessDelta;

export function createGraphIntegrityExpectationFromManifest(
  files: readonly GraphIntegrityFileStateRecord[],
  fileless: readonly GraphIntegrityFilelessStateRecord[],
): GraphIntegrityExpectation;

export function parseGraphIntegrityFilelessReferences(
  json: string,
): GraphIntegrityFilelessReferenceTuple[];

export function parseGraphIntegrityCanonicalSymbol(
  json: string,
): GraphIntegrityCanonicalSymbol;
~~~

Own GraphIntegrityFilelessReferenceTuple and the codec functions in src/indexer/provider-first/persisted-graph-integrity.ts; import the manifest record/delta types from src/db/ladybug-graph-integrity.ts. canonicalSymbolJson is produced and parsed with the existing canonical symbol field order. createGraphIntegrityFilelessDelta adjusts only touched fileless symbols, returns deterministic symbolId-ordered upserts/deletes, and suppresses zero-liveness deletion when pruningSupported is false. Do not duplicate the current digest algorithm or create a second expectation type.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-graph-integrity-manifest.test.ts tests/unit/persisted-graph-integrity.test.ts
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add src/db/ladybug-graph-integrity.ts src/db/ladybug-queries.ts src/indexer/provider-first/persisted-graph-integrity.ts tests/unit/ladybug-graph-integrity-manifest.test.ts tests/unit/persisted-graph-integrity.test.ts
git commit -m "Persist graph integrity expectations"
~~~

### Task 3: Add exclusive read-only snapshots

**Files:**

- Modify: src/db/ladybug.ts
- Modify: src/db/ladybug-core.ts
- Modify: tests/unit/ladybug-connection.test.ts
- Create: tests/integration/background-graph-integrity-snapshot.test.ts

- [ ] **Step 1: Write failing connection and snapshot tests**

Prove:

- withExclusiveReadConnection creates a temporary Connection from the existing Database and never returns a round-robin pooled connection.
- closeLadybugDb waits for active exclusive leases.
- withReadOnlyTransaction commits on a completed scan and rolls back on cancellation/query failure.
- Multiple pages observe one stable snapshot while a separate small writer commits.
- The next snapshot observes the committed edit.
- No publication write starts until the read-only transaction has ended.
- A checkpoint blocked or delayed by the held snapshot succeeds after release.

- [ ] **Step 2: Run tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-connection.test.ts tests/integration/background-graph-integrity-snapshot.test.ts
~~~

Expected: FAIL because exclusive leases and read-only transactions do not exist.

- [ ] **Step 3: Implement the two helpers**

Export the connection lease from src/db/ladybug.ts:

~~~ts
export function withExclusiveReadConnection<T>(
  fn: (conn: Connection) => Promise<T>,
): Promise<T>;
~~~

Export the snapshot helper from src/db/ladybug-core.ts:

~~~ts
export function withReadOnlyTransaction<T>(
  conn: Connection,
  fn: () => Promise<T>,
): Promise<T>;
~~~

Track active leases in ladybug.ts so close cannot race a scan. Start exactly BEGIN TRANSACTION READ ONLY. Check cancellation only between page queries; never interrupt an in-flight native query. Always commit or roll back, close the temporary connection, and release the lease in finally.

- [ ] **Step 4: Run focused tests, typecheck, and lint**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-connection.test.ts tests/integration/background-graph-integrity-snapshot.test.ts
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add src/db/ladybug.ts src/db/ladybug-core.ts tests/unit/ladybug-connection.test.ts tests/integration/background-graph-integrity-snapshot.test.ts
git commit -m "Add stable graph verification snapshots"
~~~

## Chunk 2: Background verification and saved-edit path

### Task 4: Add the coalescing background verifier

**Files:**

- Create: src/indexer/provider-first/background-graph-integrity-verifier.ts
- Modify: src/indexer/provider-first/persisted-graph-integrity.ts
- Modify: src/startup/derived-state-recovery.ts
- Create: tests/unit/background-graph-integrity-verifier.test.ts
- Modify: tests/unit/persisted-graph-integrity.test.ts
- Modify: tests/unit/derived-state-startup-recovery.test.ts

- [ ] **Step 1: Write failing worker tests**

Cover:

- notify starts verification immediately with no debounce.
- One repo has at most one running revision and one latest pending revision.
- A newer edit cancels between pages and stale success/failure CAS changes nothing.
- The worker reloads after completion, cancellation, and lost CAS.
- Startup and a five-second sweep requeue persisted verifying rows.
- Bounded retry exhaustion publishes a sanitized failure only for the current revision.
- cancelAndWait(repoId) and cancelAndWaitAll() end the read transaction and resolve only after the connection is released.
- Runtime-registered repositories are recovered, not only configured repositories.
- Production startup invokes recovery once after migrations and repository bootstrap.

- [ ] **Step 2: Run tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/background-graph-integrity-verifier.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/derived-state-startup-recovery.test.ts
~~~

Expected: FAIL because the worker does not exist.

- [ ] **Step 3: Implement the smallest worker registry**

Expose:

~~~ts
notifyGraphIntegrityVerifier(repoId)
cancelAndWaitForGraphIntegrityVerifier(repoId)
cancelAndWaitForAllGraphIntegrityVerifiers()
startGraphIntegrityVerifierRecovery()
stopGraphIntegrityVerifierRecovery()
~~~

Use one module-level map keyed by repoId. Each worker stores only running cancellation state and whether a wake is pending; DerivedState remains the durable queue. The scan:

1. leases one exclusive read connection;
2. opens one read-only transaction;
3. reads manifest plus paged actual rows;
4. commits/rolls back and releases;
5. publishes through the tiny revision CAS.

Reuse existing paging, digest, comparison, bounded diagnostic, and retry helpers. Add no public scheduler abstraction or configurable debounce.

- [ ] **Step 4: Connect startup recovery without lifecycle wiring yet**

Make derived-state recovery start the verifier sweep after migrations and repository bootstrap. Keep the production sweep fixed at five seconds; expose a direct sweep hook only for tests.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/background-graph-integrity-verifier.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/derived-state-startup-recovery.test.ts
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add src/indexer/provider-first/background-graph-integrity-verifier.ts src/indexer/provider-first/persisted-graph-integrity.ts src/startup/derived-state-recovery.ts tests/unit/background-graph-integrity-verifier.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/derived-state-startup-recovery.test.ts
git commit -m "Verify graph integrity in the background"
~~~

### Task 5: Make saved-file mutations atomic and nonblocking

**Files:**

- Modify: src/live-index/file-patcher.ts
- Modify: src/indexer/provider-first/persisted-graph-integrity.ts
- Modify: src/db/ladybug-graph-integrity.ts
- Modify: tests/unit/file-patcher.test.ts
- Modify: tests/integration/saved-file-graph-patch.test.ts
- Modify: tests/integration/symbol-edit-tool.test.ts
- Modify: tests/integration/file-write-tool.test.ts
- Modify: tests/integration/search-edit-tool.test.ts
- Modify: tests/unit/checkpoint-service.test.ts
- Modify: tests/integration/background-reconcile.test.ts
- Modify: tests/unit/watcher-save-fallback.test.ts

- [ ] **Step 1: Write failing saved-edit tests**

Prove:

- A saved edit resolves after the graph transaction commits and before a blocked verifier completes.
- The foreground performs zero calls to capturePersistedGraphIntegrity.
- Graph rows, affected file manifest, fileless delta, and revision commit or roll back together.
- Rapid edits return independently and only the newest revision becomes verified.
- A pre-edit canonical mismatch uses the direct Version+revision failure CAS and never advances the manifest.
- A lost direct-failure CAS reloads state and retries saved-file reconciliation without poisoning the newer revision.
- A missing manifest still permits the graph patch but leaves integrity unknown with full-refresh guidance.
- Checkpoint, reconcile, watcher save, symbol.edit, file.write, and search.edit continue through the same patch path.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/file-patcher.test.ts tests/integration/saved-file-graph-patch.test.ts tests/integration/symbol-edit-tool.test.ts tests/integration/file-write-tool.test.ts tests/integration/search-edit-tool.test.ts tests/unit/checkpoint-service.test.ts tests/integration/background-reconcile.test.ts tests/unit/watcher-save-fallback.test.ts
~~~

Expected: FAIL because saved edits still perform synchronous full captures.

- [ ] **Step 3: Replace the foreground session with manifest validation**

Add an optional internal-only SavedFilePatchObserver in src/live-index/file-patcher.ts with onCommitted(revision: number) and onForegroundFullGraphCapture() callbacks. Invoke onCommitted immediately after the graph/manifest/revision transaction commits and before notifying the verifier. onForegroundFullGraphCapture must run immediately before every foreground capturePersistedGraphIntegrity call; keep all such calls behind one foreground wrapper so the spy cannot be bypassed. The production MCP request and response schemas do not expose this observer. Tests inject a spy and prove the production saved-patch route invokes the wrapper zero times; the benchmark records the same counter.

Under the existing withRepoWriteHeavyLock:

1. read the current Version/revision and trusted affected-file state;
2. compare the existing canonical file rows to that state;
3. parse/reconcile the new content using trusted provider identity;
4. build the next file state and fileless delta independently;
5. enter the existing serialized write transaction;
6. revalidate Version/revision;
7. write graph, manifest, fileless delta, and revision;
8. commit;
9. notify the worker;
10. return the existing response.

Retry from the outer lock when Version/revision revalidation loses. Do not wait for verification and do not add a synchronous fallback.

- [ ] **Step 4: Preserve missing-manifest and corruption behavior**

When no trusted manifest exists, apply the graph patch and invalidateGraphIntegrity inside the same write transaction, leave integrity unknown, do not notify the verifier, and do not build a self-certifying manifest from current graph rows. When affected-file validation fails, publish the bounded direct failure CAS only if Version/revision is still current. If that CAS returns false, reload the latest state and retry saved-file reconciliation from the outer repository lock.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Rerun the complete Step 2 block, including build:runtime, then:

~~~powershell
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add src/live-index/file-patcher.ts src/indexer/provider-first/persisted-graph-integrity.ts src/db/ladybug-graph-integrity.ts tests/unit/file-patcher.test.ts tests/integration/saved-file-graph-patch.test.ts tests/integration/symbol-edit-tool.test.ts tests/integration/file-write-tool.test.ts tests/integration/search-edit-tool.test.ts tests/unit/checkpoint-service.test.ts tests/integration/background-reconcile.test.ts tests/unit/watcher-save-fallback.test.ts
git commit -m "Return saved edits before graph verification"
~~~

## Chunk 3: Mutation ownership, lifecycle, and public state

### Task 6: Integrate full/incremental indexing and shadow activation

**Files:**

- Modify: src/indexer/provider-first/persisted-graph-integrity.ts
- Modify: src/indexer/indexer.ts
- Modify: src/indexer/watcher.ts
- Modify: src/indexer/provider-first/shadow-activation.ts
- Modify: src/db/ladybug-shadow-finalization.ts
- Modify: tests/unit/provider-first-indexing.test.ts
- Modify: tests/integration/provider-first-scip-execution.test.ts
- Modify: tests/integration/provider-first-index-repo-fallback.test.ts
- Modify: tests/unit/watcher-save-fallback.test.ts

- [ ] **Step 1: Write failing index and handoff tests**

Cover:

- A full index builds a complete independent manifest, synchronously verifies it, activates it, and publishes revision 0 with pruning support true.
- Incremental indexing updates every affected manifest inside its existing synchronous integrity session.
- Watcher delete/rename continues through incremental indexing and updates/removes the file manifest plus fileless delta in the same committed revision.
- A full-index activation cannot commit over a live edit from a newer base revision.
- Shadow finalization copies both manifest node sets, relationships, revision fields, and validates counts.
- Activation cancellation leaves no verifier lease and rollback restores the previous graph/manifest.
- Direct provider writes without independent expectations invalidate integrity.

- [ ] **Step 2: Run tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/provider-first-indexing.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/provider-first-index-repo-fallback.test.ts tests/unit/watcher-save-fallback.test.ts
~~~

Expected: FAIL on missing manifest/revision behavior. The existing shadow activation and finalization coverage is in tests/unit/provider-first-indexing.test.ts and tests/integration/provider-first-index-repo-fallback.test.ts.

- [ ] **Step 3: Extend synchronous index sessions**

Reuse the pass-1 expectation accumulator and fileless liveness ledger to create the complete manifest from independent index output. Write or replace the manifest before synchronous publication. Full activation initializes both revisions to 0; ordinary incremental completion advances and synchronously verifies its revision.

- [ ] **Step 4: Extend shadow handoff**

Call cancelAndWait before close/swap. Carry recorded base Version and revision into activation, replay live edits through the existing handoff protocol, and abort on mismatch. Copy manifest nodes and Repo relationships in deterministic order and include their counts in finalization validation.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Rerun the complete Step 2 block, including build:runtime, then:

~~~powershell
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add src/indexer/provider-first/persisted-graph-integrity.ts src/indexer/indexer.ts src/indexer/watcher.ts src/indexer/provider-first/shadow-activation.ts src/db/ladybug-shadow-finalization.ts tests/unit/provider-first-indexing.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/provider-first-index-repo-fallback.test.ts tests/unit/watcher-save-fallback.test.ts
git commit -m "Carry integrity manifests through indexing"
~~~

### Task 7: Add cancellation, deletion, sync invalidation, and public status

**Files:**

- Modify: src/db/ladybug-repos.ts
- Modify: src/services/repo-lifecycle.ts
- Modify: src/startup/derived-state-recovery.ts
- Modify: src/mcp/tools/repo.ts
- Modify: src/services/health.ts
- Modify: src/sync/sync.ts
- Modify: src/main.ts
- Modify: src/cli/commands/serve.ts
- Modify: src/mcp/tools.ts
- Modify: src/mcp/context-response-projection.ts
- Modify: tests/unit/ladybug-repo-delete-exhaustive.test.ts
- Modify: tests/unit/repo-lifecycle.test.ts
- Modify: tests/integration/repo-unregister.test.ts
- Modify: tests/unit/shutdown-manager.test.ts
- Modify: tests/unit/repo-status-health.test.ts
- Modify: tests/unit/sync-artifact.test.ts
- Modify: tests/unit/derived-state-startup-recovery.test.ts
- Modify: tests/integration/determinism.test.ts
- Modify: tests/integration/determinism.fixtures.json

- [ ] **Step 1: Write failing lifecycle and public-contract tests**

Prove:

- Full index, unregister, and shutdown call cancelAndWait before graph state is closed or deleted.
- Unregister deletes both manifest node sets and relationships.
- Sync import invalidates revisions and removes stale manifests before graph writes.
- Startup recovers pending revisions after migrations/bootstrap.
- Health and retrieval distinguish latest-verified from graph-available: verifying/failed current manifests stay readable, unknown/no-manifest does not.
- repo.status serializes state, Version, current revision, verified revision, and bounded guidance in deterministic key order.
- Normal retrieval shapes remain byte-identical.

- [ ] **Step 2: Run tests and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/ladybug-repo-delete-exhaustive.test.ts tests/unit/repo-lifecycle.test.ts tests/integration/repo-unregister.test.ts tests/unit/shutdown-manager.test.ts tests/unit/repo-status-health.test.ts tests/unit/sync-artifact.test.ts tests/unit/derived-state-startup-recovery.test.ts tests/integration/determinism.test.ts
~~~

Expected: FAIL because lifecycle cancellation and public revision fields do not exist.

- [ ] **Step 3: Wire cancellation and deletion**

Use the existing beginRepoRemoval/write-heavy boundaries. Cancel and await before unregister deletion, full-index activation, DB close, and shutdown. Register verifier cleanup before DB cleanup because ShutdownManager executes in insertion order. Delete manifest relationships and nodes exhaustively.

- [ ] **Step 4: Update sync, availability, and repo.status**

Invalidate imported graph integrity before graph writes and clear stale manifests. Add current and verified revisions to DerivedStateSummary, RepoStatusResponse, and model projection with deliberate object-key order. Keep timestamps, durations, queue counters, session IDs, and absolute paths out of responses.

- [ ] **Step 5: Update deterministic fixtures and run checks**

Rerun the complete Step 2 block, including build:runtime, then:

~~~powershell
npm.cmd run test:golden
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS with only intentional repo.status fixture changes.

- [ ] **Step 6: Commit**

~~~powershell
git add src/db/ladybug-repos.ts src/services/repo-lifecycle.ts src/startup/derived-state-recovery.ts src/mcp/tools/repo.ts src/services/health.ts src/sync/sync.ts src/main.ts src/cli/commands/serve.ts src/mcp/tools.ts src/mcp/context-response-projection.ts tests/unit/ladybug-repo-delete-exhaustive.test.ts tests/unit/repo-lifecycle.test.ts tests/integration/repo-unregister.test.ts tests/unit/shutdown-manager.test.ts tests/unit/repo-status-health.test.ts tests/unit/sync-artifact.test.ts tests/unit/derived-state-startup-recovery.test.ts tests/integration/determinism.test.ts tests/integration/determinism.fixtures.json
git commit -m "Integrate graph verifier lifecycle and status"
~~~

## Chunk 4: Performance evidence and documentation

### Task 8: Add deterministic performance gates and finish documentation

**Files:**

- Create: scripts/background-graph-integrity-benchmark.ts
- Modify: src/live-index/file-patcher.ts
- Modify: tests/unit/file-patcher.test.ts
- Modify: package.json
- Modify: .github/workflows/ci.yml
- Modify: CHANGELOG.md
- Modify: docs/symbol-edit-tool.md
- Modify: docs/mcp-tools-reference.md
- Modify: docs/mcp-tools-reference-detailed.md
- Modify: docs/architecture.md
- Modify: docs/prompt-cache-hygiene.md
- Modify: SDL.md
- Create: tests/benchmark/background-graph-integrity.test.ts

- [ ] **Step 1: Write the failing benchmark contract test**

Generate the fixed background-integrity-v1 fixture:

- 1,500 TypeScript files.
- 20 canonical symbols per file.
- Fixed cross-file placeholder/reference pattern.
- Stable fixture hash and edit sequence.

Assert the artifact schema records schema version, commit SHA, OS, CPU when available, Node, LadybugDB, addon mode, fixture seed, fixture hash, edit-sequence hash, cache mode, raw candidate/control samples, p50, nearest-rank p95, timeout count, thresholds, foreground capture count, per-check passed booleans, and one top-level passed boolean.

Test the arithmetic independently: nearest-rank p95, strict 500 ms and 1 second boundaries, the 20 percent same-run ratio, the 3.5 second verification boundary, timeout failure, zero-capture failure, and overall pass/fail aggregation. Use injected fake timing for the timeout contract; the test must not sleep for 30 seconds. Assert candidate and control receive byte-identical starting fixtures and edit sequences, and that the control promise cannot resolve before its synchronous capture/compare/publication completes.

- [ ] **Step 2: Run the benchmark test and confirm RED**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/benchmark/background-graph-integrity.test.ts
~~~

Expected: FAIL because the generator/harness does not exist.

- [ ] **Step 3: Implement one benchmark harness**

Add this exact package script:

~~~json
"benchmark:background-graph-integrity": "node --experimental-strip-types scripts/background-graph-integrity-benchmark.ts"
~~~

Generate one seeded base database, close and checkpoint it, then make separate candidate and synchronous-control clones from the same bytes. Apply the same ordered edits to both lanes. Each lane uses three warmups followed by 20 measured serial samples, and each sample has a hard 30-second timeout.

For the candidate, start performance.now() immediately before calling the production saved-file patch and stop when that promise resolves. Use SavedFilePatchObserver.onCommitted to record the exact committed revision and a second performance.now() value immediately after commit but before verifier notification. Stop background timing only when graphIntegrityVerifiedRevision equals that exact revision; a later revision or a failed/unknown state fails the sample. Wait for exact verification before beginning the next serial sample.

The benchmark-only control composes shared production primitives in the approved synchronous order: capture the trusted baseline; apply the saved-file graph, manifest, and revision transaction without notifying or starting the worker; capture and compare the resulting persisted graph; publish the exact revision through the production CAS; then resolve the measured promise. Do not add a production flag, alternate MCP tool path, or duplicate digest implementation.

After the serial lanes, commit one candidate edit, immediately time a second edit while the first revision is still verifying, then require the newest exact revision to verify. The concurrent foreground sample must be below 1 second. Record observer calls during each candidate foreground promise; onForegroundFullGraphCapture must remain zero.

Enforce:

~~~text
candidate foreground p50 < 500 ms
candidate foreground p95 < 1 second
candidate p50 <= 20 percent of same-run control p50
concurrent foreground edit < 1 second
background verification p95 <= 3.5 seconds
foreground full-graph captures = 0
~~~

Write the artifact to the required --out path under .benchmark/background-graph-integrity/. Add a dedicated background-integrity-benchmark job, separate from the Ubuntu-only benchmarks job, with a matrix of ubuntu-latest and windows-latest. On both runners use Node 24.x, npm ci --ignore-scripts --legacy-peer-deps, the repository tree-sitter setup action, the existing LadybugDB binary setup, SDL_MCP_DISABLE_NATIVE_ADDON=1, npm run build:all, and:

~~~text
npm run benchmark:background-graph-integrity -- --out .benchmark/background-graph-integrity/${{ runner.os }}-${{ github.sha }}.json
~~~

The command must enforce the gates and return nonzero on failure. Upload with if: always(), artifact name background-graph-integrity-${{ runner.os }}, exact JSON path above, and if-no-files-found: error so failure evidence survives. Do not enable Windows in the existing benchmarks job or overload the provider-first benchmark.

- [ ] **Step 4: Update documentation**

Document:

- fast foreground graph commit and asynchronous verification;
- revision-safe CAS and restart recovery;
- verifying/failed availability without latest-verified claims;
- missing-manifest full-refresh guidance;
- unchanged PageRank, clusters, summaries, embeddings, and derived-state scope;
- new repo.status current/verified revision fields;
- prompt-cache deterministic response rules.

In docs/architecture.md, include the file/fileless manifest nodes, Repo relationships, revision ownership, exclusive snapshot, CAS publication, startup recovery, and cancel-before-close lifecycle. In docs/symbol-edit-tool.md, show how to inspect repo.status after symbol.edit and distinguish current revision, verified revision, verifying, failed-but-available, and unknown/full-refresh states. Keep the expanded Persisted graph integrity gate CHANGELOG entry in followable sub-items.

- [ ] **Step 5: Run benchmark contract, documentation, and generated-reference checks**

Run:

~~~powershell
npm.cmd run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/benchmark/background-graph-integrity.test.ts
npm.cmd run typecheck:scripts
npm.cmd run docs:tools:check
npm.cmd run test:golden
npm.cmd run typecheck
npm.cmd run lint
~~~

Expected: PASS.

Run the full performance benchmark locally with:

~~~powershell
$benchmarkArtifact = ".benchmark/background-graph-integrity/task8-working-tree.json"
npm.cmd run benchmark:background-graph-integrity -- --out $benchmarkArtifact
~~~

Retain this development artifact and confirm it contains the current base commit SHA, fixture and edit-sequence hashes, schema version, thresholds, raw samples, and passing checks. Final-SHA evidence is produced only after Task 8 and all review fixes are committed. CI must execute the same gate on both maintained operating systems.

- [ ] **Step 6: Commit**

~~~powershell
git add scripts/background-graph-integrity-benchmark.ts src/live-index/file-patcher.ts tests/unit/file-patcher.test.ts tests/benchmark/background-graph-integrity.test.ts package.json .github/workflows/ci.yml CHANGELOG.md docs/symbol-edit-tool.md docs/mcp-tools-reference.md docs/mcp-tools-reference-detailed.md docs/architecture.md docs/prompt-cache-hygiene.md SDL.md
git commit -m "Benchmark and document background verification"
~~~

## Final verification

- [ ] Run the complete test suite:

~~~powershell
npm.cmd test
~~~

- [ ] Run build, typecheck, lint, golden, workflow, schema, and docs checks:

~~~powershell
npm.cmd run build:all
npm.cmd run typecheck
npm.cmd run typecheck:scripts
npm.cmd run lint
npm.cmd run test:golden
npm.cmd run check:schema-sync
npm.cmd run docs:tools:check
~~~

- [ ] Commit all review fixes, then require a clean tracked worktree before collecting final evidence:

~~~powershell
git diff --check
git status --short
git add -u
git diff --cached --check
git commit -m "Address background integrity review findings"
git diff --check HEAD
git status --short
~~~

Skip the review-fix commit only when git status --short was already empty. Expected before benchmarking: no tracked or untracked changes; ignored benchmark artifacts may remain.

- [ ] Run the final benchmark gate against that clean exact HEAD and retain its raw artifact:

~~~powershell
$finalSha = git rev-parse HEAD
$benchmarkArtifact = ".benchmark/background-graph-integrity/final-$($finalSha.Substring(0, 12)).json"
npm.cmd run benchmark:background-graph-integrity -- --out $benchmarkArtifact
Get-Content -LiteralPath $benchmarkArtifact
if ((Get-Content -LiteralPath $benchmarkArtifact | ConvertFrom-Json).commitSha -ne $finalSha) { throw "Benchmark artifact SHA mismatch" }
~~~

- [ ] Re-read the approved specification and audit every mutation row in its ownership table against code and tests.

- [ ] Confirm the final change scope and retained evidence are clean:

~~~powershell
git diff --check
git diff --check c6757f49...HEAD
git diff --name-status c6757f49...HEAD
git status --short
Get-ChildItem -LiteralPath .benchmark/background-graph-integrity -File
~~~

Expected: only planned source, test, documentation, workflow, and the intentionally ignored benchmark artifact are present; no temporary databases, generated fixtures, or backup files are tracked.

- [ ] Dispatch a final specification reviewer, Ladybug specialist, code-quality reviewer, and security reviewer with only the approved specification and c6757f49...HEAD diff. Fix every Critical or Important issue and re-run affected checks.

- [ ] After the last review fix, rerun every command in Final verification, including the full suite and performance gate. Audit all eight tasks, every mutation-ownership row, lifecycle cancellation, public documentation, and deterministic fixtures against the approved specification.

- [ ] Record exact final evidence:

~~~powershell
$finalSha = git rev-parse HEAD
$benchmarkArtifact = ".benchmark/background-graph-integrity/final-$($finalSha.Substring(0, 12)).json"
git rev-parse c6757f49
$finalSha
git log --oneline c6757f49..HEAD
git status --short
Get-FileHash -Algorithm SHA256 $benchmarkArtifact
~~~

- [ ] Push the exact final branch, dispatch CI for that ref, and require both maintained OS lanes to pass:

~~~powershell
$finalSha = git rev-parse HEAD
git push -u origin codex/background-graph-integrity
gh workflow run ci.yml --ref codex/background-graph-integrity
$deadline = (Get-Date).AddMinutes(2)
do { Start-Sleep -Seconds 5; $runs = @(gh run list --workflow ci.yml --branch codex/background-graph-integrity --event workflow_dispatch --limit 10 --json databaseId,headSha,status,conclusion,url | ConvertFrom-Json); $run = $runs | Where-Object headSha -eq $finalSha | Select-Object -First 1 } until ($run -or (Get-Date) -ge $deadline)
if (-not $run) { throw "CI run for final SHA was not visible before timeout" }
gh run watch $run.databaseId --exit-status; if ($LASTEXITCODE -ne 0) { throw "CI failed" }
$view = gh run view $run.databaseId --json headSha,url,jobs | ConvertFrom-Json; $jobs = @($view.jobs | Where-Object name -Like "background-integrity-benchmark*"); if ($view.headSha -ne $finalSha -or $jobs.Count -ne 2 -or @($jobs | Where-Object conclusion -ne "success").Count -ne 0) { throw "Required OS jobs did not pass for final SHA" }
$ciRoot = ".benchmark/background-graph-integrity/ci-$($finalSha.Substring(0, 12))"; gh run download $run.databaseId -n background-graph-integrity-Linux -D "$ciRoot/linux"; if ($LASTEXITCODE -ne 0) { throw "Linux artifact download failed" }; gh run download $run.databaseId -n background-graph-integrity-Windows -D "$ciRoot/windows"; if ($LASTEXITCODE -ne 0) { throw "Windows artifact download failed" }
foreach ($os in @("linux","windows")) { $path = Get-ChildItem -LiteralPath "$ciRoot/$os" -Recurse -File -Filter "*.json" | Select-Object -First 1; $artifact = Get-Content -LiteralPath $path.FullName | ConvertFrom-Json; if ($artifact.commitSha -ne $finalSha -or -not $artifact.passed -or @($artifact.checks | Where-Object { -not $_.passed }).Count -ne 0) { throw "$os artifact validation failed" } }
~~~

Verify the background-integrity-benchmark matrix entries for ubuntu-latest and windows-latest both conclude success for finalSha, both used the same package gate, and both OS-specific JSON artifacts contain that exact commit SHA and passing checks. If either lane cannot be run or fails, the goal remains incomplete.
