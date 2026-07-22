# Background Graph Integrity Verification

Status: Approved design

Date: 2026-07-20

## Purpose

SDL-MCP currently verifies a saved symbol edit synchronously. On a representative 28,855-symbol SDL-MCP database, the saved-file patch and verification path takes a median of 4.82 seconds because it captures the persisted symbol universe before and after the mutation.

This design removes full-graph verification from the foreground edit path. A symbol edit commits its graph mutation and expected file digest quickly, while a per-repository worker verifies the latest committed revision in the background. Graph reads remain available while verification is pending, but SDL-MCP does not claim that the latest revision is verified until a revision-checked publication succeeds.

## Goals

- Keep the foreground saved-symbol-edit path below 500 ms at the current repository scale, with a p95 below one second.
- Preserve independent verification of persisted symbol identity and provenance.
- Allow graph reads while the latest revision is `verifying` or `failed`.
- Coalesce rapid edits and prevent stale verification results from publishing.
- Recover unfinished verification after process restart.
- Preserve existing retrieval response shapes and prompt-cache determinism.

## Non-goals

- Recompute PageRank, centrality, clusters, summaries, or embeddings after each edit.
- Expand the integrity gate to validate every graph edge.
- Add a LadybugDB stored procedure or native extension in the first implementation.
- Maintain a second shadow graph for reads.
- Automatically reindex after a verification failure.

## Current behavior

`symbol.edit` applies its saved-file plan through the shared batch executor. The executor writes the file and awaits `syncLiveIndex()`, which calls `patchSavedFile()`.

`patchSavedFile()` holds the repository write-heavy lock while `PersistedGraphIntegritySession.begin()` captures the verified baseline, the transaction patches symbols and parser-owned edges, and `PersistedGraphIntegritySession.complete()` captures the graph again and publishes the result. The two full captures dominate the measured foreground latency.

The current publication CAS checks only `graphIntegrityState` and `graphIntegrityVersionId`. Live edits intentionally retain the same Version, so version ID alone cannot distinguish consecutive saved-file revisions.

## Considered approaches

### Persisted per-file manifest and background verifier

Persist one independently constructed expected digest per file, update the affected row in the edit transaction, and verify the full graph on a background read-only snapshot. This approach survives restarts, removes both captures from the writer, and provides a durable revision CAS.

This is the selected approach.

### In-memory integrity session

Retain the current expected graph in process memory and move only `complete()` to a background worker. This approach requires less schema work, but the first edit after restart still needs a blocking baseline capture. A crash also discards the independent expectation.

This approach does not consistently meet the foreground-latency goal.

### LadybugDB stored procedure

Compute the digest inside LadybugDB to reduce row transfer. `CALL` still executes synchronously on its connection and does not create a detached database job. A custom procedure would also require native extension maintenance while leaving revision scheduling and publication correctness in SDL-MCP.

This optimization is deferred unless the background scan becomes a measured bottleneck.

## Data model

### Derived state revisions

Add these fields to `DerivedState`:

- `graphIntegrityRevision`: the latest committed live-graph mutation for the current Version.
- `graphIntegrityVerifiedRevision`: the latest revision successfully verified for the current Version.
- `graphIntegrityFilelessPruningSupported`: whether the trusted manifest has enough fileless-liveness history to apply existing placeholder-pruning rules during live edits.
- `graphIntegrityManifestEstablished`: whether full or incremental indexing has durably replaced the repository manifest, including a valid empty manifest.

Keep `graphIntegrityVersionId` as the owning Version. Full indexing establishes a new Version and initializes both revision counters to `0`. Each later graph mutation calculates `newRevision = previousRevision + 1` inside the owning write transaction and maps LadybugDB integers through the existing number-conversion helpers.

Saved-file patching trusts an absent per-file row only when the durable manifest marker is true and the file has no existing canonical symbols. This distinguishes a valid empty manifest or omitted symbol-free file from legacy state that was marked verified without ever establishing manifest ownership.

`graphIntegrityDigest` records the digest of `graphIntegrityVerifiedRevision`. Consumers must require all of the following before describing the latest graph as verified:

- `graphIntegrityState === "verified"`
- `graphIntegrityVersionId === latestVersionId`
- `graphIntegrityRevision !== null`
- `graphIntegrityVerifiedRevision !== null`
- `graphIntegrityVerifiedRevision === graphIntegrityRevision`

When a newer revision enters `verifying` or `failed`, SDL-MCP preserves the previous verified digest for diagnostics, but it must not present that digest as proof of the current revision.

### Per-file expectation manifest

Add a `GraphIntegrityFileState` table with one row per expected file digest:

- `stateId`: stable repository-and-file key.
- `repoId`: owning repository.
- `fileId`: durable file identity.
- `relPath`: normalized repository-relative path.
- `symbolCount`: expected canonical symbol count.
- `digest`: expected canonical file digest.
- `filelessReferencesJson`: deterministic counts of this file's expected references to fileless symbols.

Add a `GraphIntegrityFilelessState` table with one row per expected fileless symbol:

- `stateId`: stable repository-and-symbol key.
- `repoId`: owning repository.
- `symbolId`: expected fileless symbol identity.
- `canonicalSymbolJson`: deterministic canonical symbol fields.
- `referenceCount`: expected cross-file liveness count.

Connect both manifest node types to their owning `Repo` through `GRAPH_INTEGRITY_FILE_STATE_IN_REPO` and `GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO` relationship tables. LadybugDB 0.18.1 cannot index ordinary custom properties, so repository-scoped manifest reads traverse these relationships; exact row reads continue to use the `stateId` primary key.

The fileless manifest persists the inputs currently held by `GraphIntegrityFilelessLivenessLedger`; it must not reconstruct them from post-write Symbol or Edge rows. A live patch diffs the affected file's previous and next deterministic, typed `filelessReferencesJson`, adjusts expected reference counts, and upserts new independently constructed placeholder/provider expectations. It removes zero-liveness entries under the existing pruning rules only when `graphIntegrityFilelessPruningSupported` is true; otherwise it conservatively retains them until the next full refresh rebuilds complete liveness history.

Use the existing fileless sentinel when producing the global expected digest. The manifest does not need to persist page diagnostics; the verifier can generate bounded mismatch diagnostics from the actual scan when comparison fails.

The parser/reconciliation path constructs the manifest digest independently before persistence. The graph-row writes and manifest-row mutation then commit in the same LadybugDB write transaction.

Before reusing durable provider identity from an existing file, the patch reads that file's canonical Symbol rows and confirms that their digest matches the trusted manifest row. This affected-file check is O(symbols in one file), not O(repository symbols). A mismatch prevents manifest advancement and marks the revision failed, so corrupted provider metadata cannot be copied into a new expectation and self-certified.

If affected-file validation fails before a new revision exists, SDL-MCP performs a direct failure CAS against the recorded Version and current revision. The CAS sets the state to `failed`, preserves the prior verified revision and digest, and publishes a bounded mismatch diagnostic only when no intervening mutation changed the Version or revision. A lost CAS reloads state and retries saved-file reconciliation instead of poisoning a newer revision.

## Foreground edit flow

The saved-file patch performs these steps:

1. Acquire the existing per-repository write-heavy lock and record the current Version and revision.
2. Validate the affected file's durable canonical digest against its trusted manifest row.
3. Parse the new content and reconcile extracted symbols with trusted durable identities.
4. Construct the expected file digest and fileless-reference delta from the reconciled parse result.
5. Enter the existing serialized write transaction.
6. Re-read the latest Version and revision; abort and retry from step 1 if either changed.
7. Patch the File, Symbol, reference, and parser-owned edge rows.
8. Upsert or delete the affected file manifest and apply the fileless-manifest delta.
9. Increment `graphIntegrityRevision` and set `graphIntegrityState` to `verifying` without advancing the verified revision or digest.
10. Commit the graph, manifests, and revision atomically.
11. Notify the verifier and return the existing edit response.

The foreground path must not call `capturePersistedGraphIntegrity()`. It must not wait for the background worker, and it must not fall back to synchronous verification.

If the repository has no trusted manifest, the edit may still patch the graph, but SDL-MCP leaves integrity unverified and directs the user to run one full refresh. It must not self-certify by deriving both the expected and actual state from the same persisted rows.

## Mutation ownership and Version coordination

Every production path that changes File, Symbol, or integrity-relevant placeholder state must either update the expected manifest and revision in the same transaction or explicitly invalidate integrity.

| Mutation path | Required ownership |
| --- | --- |
| Saved file or `symbol.edit` | Validate affected manifest, patch graph and manifest atomically, increment one revision, notify verifier. |
| Watcher save/checkpoint | Use the same saved-file patch path; do not maintain a parallel integrity implementation. |
| File deletion or rename | Remove or move the file manifest, apply its fileless-reference delta, patch graph rows, and increment one revision atomically. |
| Incremental `index.refresh` | Update all affected manifests inside the existing incremental integrity session and publish only after its current synchronous completion gate succeeds. |
| Full provider/legacy index | Build a complete manifest from independent index output, verify it synchronously, and swap graph plus manifest during activation. |
| Provider reconciliation | Run through the owning incremental/full index transaction; direct provider graph writes must invalidate integrity if no expectation is available. |
| Transaction rollback | Roll back graph rows, manifests, and revision together; do not notify the worker. |
| Unregister | Cancel and await verification before deleting repository state. |
| Unsupported/direct mutation | Invalidate integrity and require a full refresh. |

Saved-file patches, incremental mutation, full-index activation, and unregister serialize their commit/activation phase through the same per-repository write-heavy lock. A shadow full index may build outside the lock, but activation must use the existing handoff protocol to replay committed live edits or abort when its recorded base Version/revision no longer matches. No edit parsed against one Version may commit after another Version becomes active.

## Background verification worker

Create one coalescing worker per repository. Each repository has at most one running revision and one pending latest revision.

The active SDL-MCP process owns the worker for its exclusively opened embedded database. Multi-process writers against one LadybugDB file remain unsupported; this design does not add distributed leases.

The worker performs these steps:

1. Lease one read connection exclusively for the complete scan.
2. Start an explicit `BEGIN TRANSACTION READ ONLY` snapshot.
3. Read the expected file/fileless manifests and actual canonical Symbol rows from the same snapshot.
4. Page actual symbols in deterministic `relPath`, `fileId`, and `symbolId` order.
5. Compare expected and actual file/global digests.
6. Commit the read-only transaction on success, or roll it back on cancellation/error, and release the lease in `finally`.
7. Publish the result through a tiny write CAS for the scanned Version and revision.

The scan does not hold `withRepoWriteHeavyLock`. LadybugDB supports concurrent readers with its single writer, although a long read transaction can delay a checkpoint when the WAL threshold is crossed.

Verification starts after commit without an artificial debounce. A later edit signals the running worker to stop between pages. The final CAS remains authoritative if cancellation arrives late or another mutation commits a newer revision.

`DerivedState` is the durable work record; the in-memory notification only wakes the worker. The worker reloads persisted state at startup, after every completed/canceled run, and through a fixed five-second recovery sweep so a commit-to-notification crash or lost wakeup cannot strand `verifying`. A stale CAS also reloads the latest persisted revision before deciding whether to run again.

## Publication rules

Successful publication requires:

```text
graphIntegrityState = "verifying"
AND graphIntegrityVersionId = scannedVersionId
AND graphIntegrityRevision = scannedRevision
```

On success, SDL-MCP sets:

```text
graphIntegrityState = "verified"
graphIntegrityVerifiedRevision = scannedRevision
graphIntegrityDigest = actualDigest
graphIntegrityError = NULL
```

Failure publication uses the same Version-and-revision CAS. A stale success or stale failure changes nothing and triggers verification of the newest pending revision.

Entering `verifying` or `failed` must preserve `graphIntegrityVerifiedRevision` and the digest associated with it. Failure never advances either field. Every predicate that describes the latest graph as verified requires Version equality and `graphIntegrityVerifiedRevision === graphIntegrityRevision`; the presence of an older digest alone is never sufficient.

## Availability and public behavior

Graph-backed reads remain available while integrity is `verifying` or `failed`. The design intentionally favors availability while refusing to mislabel the latest graph as verified.

Normal retrieval payloads remain unchanged. `repo.status` and optional diagnostics expose deterministic state only:

- Current integrity state.
- Current revision.
- Verified revision.
- Version association.
- Sanitized failure and recovery guidance.

Tool responses must not include verification timestamps, durations, queue counters, session IDs, or absolute paths. Operational timing belongs in logs and benchmark artifacts.

## Failure and recovery

### New edit during verification

The worker abandons the stale scan between pages when possible. If the scan finishes, its CAS fails because the revision changed. The worker then verifies the newest pending revision.

### Current-revision mismatch

The worker marks only the current revision `failed`, retains bounded diagnostics, and leaves graph reads available. SDL-MCP does not automatically reindex.

### Transient database error

The worker uses the existing bounded retry policy. After retry exhaustion, it publishes a sanitized failure only if the scanned revision remains current.

### Process restart

Startup recovery finds repositories where `graphIntegrityState === "verifying"` and `graphIntegrityRevision > graphIntegrityVerifiedRevision`, then requeues those revisions. The persisted manifest supplies the independent expectation.

### Full index, unregister, or shutdown

These operations call a per-repository `cancelAndWait()` boundary. Cancellation rolls back an active read-only transaction, releases its connection lease in `finally`, and resolves only after no verifier is using repository state. Version and revision checks remain a second guard against late publication. A full index replaces the manifest atomically and establishes a verified initial revision for the new Version.

## Migration

Add migration `m023` to the existing LadybugDB migration registry. The migration adds the two nullable revision properties, the nullable fileless-pruning-support property, the `GraphIntegrityFileState` and `GraphIntegrityFilelessState` tables, and their manifest-to-`Repo` relationship tables. It does not attempt unsupported custom-property indexes.

For existing repositories, `m023` writes the persisted representation of `unknown` to `graphIntegrityState` and leaves both revision fields and `graphIntegrityFilelessPruningSupported` unset because no independent manifest exists. It preserves the old Version and digest only as diagnostic history. The verified predicate requires both revision fields to be non-null, so equality between two unset values cannot certify the graph. The migration does not rebuild or reindex automatically.

An existing repository without a complete manifest remains unverified until one full refresh builds and verifies the manifest. Startup and saved-file patches must not reconstruct a manifest from existing Symbol rows and immediately mark those same rows verified.

No public configuration flag or dual verification mode is added. Full indexing continues to use synchronous final verification because activation must publish only a complete verified graph.

## Verification plan

### Correctness tests

- A saved edit returns before the background verifier completes.
- Graph reads succeed while state is `verifying` and `failed`.
- Graph rows and the affected manifest row commit or roll back together.
- Rapid edits publish only the newest revision.
- Stale success and stale failure results do not change state.
- A genuine current-revision mismatch publishes `failed`.
- Restart recovery requeues an unfinished revision.
- Full refresh atomically replaces the manifest and revision state.
- Full index, unregister, and shutdown cancel pending work safely.
- A missing manifest requires a full refresh and never self-certifies.
- Fileless placeholder/provider identity remains covered.
- A changed file cannot reuse provider metadata when its pre-edit canonical digest disagrees with the trusted manifest.
- Every mutation path in the ownership table either advances the manifest/revision atomically or invalidates integrity.
- Full-index activation cannot commit over a live edit from a newer base revision.
- The recovery sweep picks up a persisted revision when the immediate notification is suppressed.
- Existing retrieval payloads and deterministic key ordering remain unchanged.
- `repo.status` serializes each unverified, verifying, verified, and failed revision state deterministically.

### LadybugDB integration tests

- A read-only verification snapshot remains internally consistent across multiple pages.
- A symbol edit can commit while the verifier holds its read-only snapshot.
- The final CAS waits only for the short publication write.
- Checkpoint interaction is bounded and leaves no active transaction after cancellation.
- Numeric revision values use the repository's LadybugDB number-conversion helpers.
- Repository-scoped manifest reads traverse manifest-to-`Repo` relationships and never attempt unsupported custom-property indexes.
- Live edits prune zero-liveness fileless expectations only when the persisted pruning-support flag is true.

### Performance gates

Add a deterministic benchmark fixture generator with seed `background-integrity-v1`: 1,500 TypeScript files, 20 canonical symbols per file, and a fixed cross-file placeholder-reference pattern. Build runtime output first and run under Node 24.x with the native addon mode recorded in the artifact.

Each lane uses a fresh clone of the generated baseline database, three unmeasured warmups, and 20 measured serial samples. Report p50 and nearest-rank p95 from `performance.now()` wall time. Foreground time starts immediately before saved-edit apply and stops when the response resolves. Background time starts at the committed revision and stops when that exact revision reaches `verified`. Each sample has a 30-second timeout.

The same benchmark run includes a synchronous control lane on separate fresh database clones. The control composes the shared production primitives in the current order: capture the trusted baseline, apply the saved-file graph and manifest transaction with the background worker disabled, capture and compare the resulting persisted graph, and publish integrity before returning. This composition exists only in the benchmark harness; it does not add a production flag or tool path. The candidate and control use the same fixture, warmup count, 20-sample edit sequence, cache mode, runtime, and percentile calculation, and the artifact records raw samples for both lanes.

Run the benchmark in the maintained Windows and Ubuntu CI classes. Record runner OS, CPU model when available, Node version, LadybugDB version, addon mode, fixture hash, cache mode, raw samples, and calculated percentiles in the durable artifact.

Required gates:

- Foreground saved edit p50 below 500 ms.
- Foreground saved edit p95 below one second.
- Candidate foreground p50 at least 80% faster than the same-run synchronous control p50.
- An edit committed during a running verification scan still meets the foreground gate.
- Background verification p95 is at most 3.5 seconds.
- Instrumentation proves that the foreground edit performs zero full-graph captures.

Benchmark timings belong in durable artifacts, not MCP payloads.

## Documentation

Update these surfaces with the implemented behavior:

- `CHANGELOG.md`: describe fast foreground edits, revision-safe background verification, recovery, and the unchanged derived-state scope.
- `docs/symbol-edit-tool.md`: document asynchronous verification and status inspection.
- `docs/mcp-tools-reference.md` and detailed reference: document the new `repo.status` revision fields.
- `docs/architecture.md`: document the manifest and verifier lifecycle.
- `docs/prompt-cache-hygiene.md` and determinism fixtures if the intentional `repo.status` shape changes.
- `SDL.md`: advise agents that `verifying` permits reads but does not prove the latest revision.

## Acceptance criteria

The change is complete when:

1. Saved symbol edits no longer perform a foreground full-graph capture.
2. Graph and manifest mutations commit atomically with a monotonically increasing revision.
3. The background verifier uses a stable read-only snapshot and revision CAS.
4. Stale results cannot publish success or failure.
5. Reads remain available without claiming that a pending revision is verified.
6. Restart and lifecycle cancellation paths are regression-tested.
7. The representative performance gates pass in both maintained Windows and Ubuntu CI lanes.
8. Documentation and deterministic tool fixtures match the new public state model.
