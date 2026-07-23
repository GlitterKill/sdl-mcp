# Graph Integrity Safe Recovery and Background Reconciliation

Status: Approved for implementation

Date: 2026-07-23

## Purpose

The configured SDL-MCP graph contains physically duplicated `Symbol` primary
keys after a full provider-first refresh committed provider rows and then
failed during legacy fallback cleanup. The same database also repeatedly
reports equal expected and actual symbol counts with different
`FILELESS_SENTINEL` digests after saved-file reconciliation.

This design provides a safe recovery path and prevents the two failures from
recurring:

- refuse to mutate a physically incoherent active `Symbol` table;
- refuse destructive in-place full refreshes of a populated graph;
- rebuild every configured repository into one fresh database and validate it
  after checkpoint, close, and reopen;
- keep saved-file placeholder rows and their independent integrity manifest in
  the same canonical form;
- coalesce pending background verification before a no-op incremental check;
- stop watcher fallback and retry amplification for permanent integrity
  failures; and
- keep audit writes out of full-refresh transaction boundaries.

The active database remains readable until an operator explicitly switches the
configured path. A failed candidate is retained for diagnosis and is never
activated automatically.

## Incident facts

The recovery decision is based on the following observed facts:

- The configured database contains 59,160 physical `Symbol` nodes but only
  57,194 distinct `symbolId` values. There are 1,966 duplicate groups, each an
  exact doubleton.
- A provider-first transaction committed 29,128 symbols before legacy fallback
  began.
- The later fallback cleanup failed because a selected `Symbol` node still had
  a `SYMBOL_IN_FILE` relationship.
- A later `MERGE` retry failed the primary-key uniqueness check. That error is a
  symptom of the already-incoherent table, not a repair opportunity.
- Seven saved-file revisions had equal expected and actual counts and bounds
  but different fileless digests.
- The saved-file manifest predicted blank stable fields for new dependency
  placeholders, while full finalization and shared placeholders use canonical
  fields (`name = symbolId`, `kind/language = unknown`, and
  `astFingerprint = symbolId`).
- The configured database contains four repositories.
- Existing provider-first shadow databases are repository-scoped, while
  activation replaces the whole LadybugDB path.
- LadybugDB 0.18.1's existing shadow finalizer deliberately refuses Symbol
  mutation above 2,048 rows. The affected repository has roughly 29,000
  provider symbols.

## Safety invariants

1. The quarantined database and all discovered WAL/checkpoint sidecars are
   forensic evidence. Recovery never deletes, edits, deduplicates, unregisters,
   or reindexes that database in place.
2. A global Symbol primary key is healthy only when
   `count(s) === count(DISTINCT s.symbolId)` from a direct `MATCH (s:Symbol)`
   label scan.
3. Integrity preflight never traverses `SYMBOL_IN_REPO` or `SYMBOL_IN_FILE`,
   never scopes on `s.repoId`, and never uses `count(DISTINCT s)`. Those forms
   can hide or inflate the physical duplicate condition.
4. A populated active repository is never destructively full-refreshed in
   place. It requires an explicitly isolated whole-database rebuild.
5. A multi-repository candidate contains every configured repository before it
   can be considered for activation.
6. Candidate validation runs on a fresh connection after checkpoint, close,
   and reopen.
7. Configuration changes happen only while no SDL process owns the active
   database.
8. Saved-file graph rows, canonical placeholder fields, manifest changes, and
   revision advancement commit in one LadybugDB transaction.
9. Watchers retry only failures known to be transient. Storage corruption and
   graph-baseline failures are permanent until an explicit recovery action.
10. Audit writes do not open independent transactions during an explicitly
    scoped full refresh or database handoff.

## Considered approaches

### In-place deduplication

Delete relationships, `DETACH DELETE` duplicate nodes, rebuild the primary-key
index, and continue using the configured database.

Rejected. On the incoherent table, index lookup and label scan do not reliably
select the same physical node. A repair query can delete the authoritative copy,
retain the wrong metadata copy, or hit another connected-node failure. It also
cannot reconstruct which committed Version and manifest owned the mixed graph.

### Extend the existing repository shadow

Put provider rows and legacy fallback into the existing provider-first shadow,
then activate it.

Rejected for this recovery. The shadow is repository-scoped but path activation
replaces the entire configured database, which would erase the other three
repositories. Its finalizer also rejects Symbol mutation above the 2,048-row
LadybugDB safety ceiling. Raising that ceiling would discard an evidence-based
safety guard rather than solve the ownership problem.

### Isolated whole-database rebuild

Build all configured repositories into a new, non-existent database path,
checkpoint and close it, reopen it, validate storage and graph state, then
leave activation as an explicit stopped-server configuration change.

Selected. This keeps the old database immutable, turns any partial build into a
discardable candidate, supports the actual multi-repository configuration, and
does not require unsafe large-table mutation during activation.

## Product behavior

### Physical Symbol preflight

Add a read-only storage check:

```cypher
MATCH (s:Symbol)
RETURN count(s) AS physicalTotal,
       count(DISTINCT s.symbolId) AS distinctTotal
```

Both LadybugDB values pass through `toNumber()`. When the totals differ, a
second bounded diagnostic query samples duplicate IDs:

```cypher
MATCH (s:Symbol)
WITH s.symbolId AS symbolId, count(*) AS copies
WHERE copies > 1
RETURN symbolId, copies
ORDER BY symbolId
LIMIT $limit
```

The check raises `StorageIntegrityError`, a typed non-retryable error with
bounded, path-free recovery guidance.

`indexRepo()` runs the check inside serialized repository admission and before:

- SCIP generation;
- WAL checkpoint;
- FTS drop/rebuild;
- graph-integrity ownership changes; and
- any graph write.

A corrupt active database therefore fails quickly without making the incident
worse or spending time regenerating provider artifacts.

### Destructive full-refresh guard

An explicit full refresh of a repository that already has persisted files is
unsafe unless the caller declares that the database path is an isolated,
non-active rebuild candidate.

Add `isolatedRebuild` to the internal `IndexRepoOptions`. Normal MCP, watcher,
and CLI calls leave it false. The offline safe-rebuild path sets it only after
validating a non-existent candidate family. `benchmark:ci` may also set it
after proving its dedicated graph and WAL family did not exist before the
command opened the database. Before SCIP or writes, `indexRepo()` raises a typed
`SafeRebuildRequiredError` when:

- mode is `full`;
- the repository already has persisted files; and
- `isolatedRebuild` is not true.

Fresh first indexes remain allowed. An incremental request that is promoted to
full because the repository is absent or empty also remains allowed.

This fail-closed rule prevents the exact provider-commit/fallback-failure
sequence on healthy active databases. It intentionally prefers an explicit
safe rebuild over a fast but non-atomic in-place refresh.

### Whole-database rebuild command

Extend `sdl-mcp index` with:

```text
--safe-rebuild PATH
```

The option:

- requires `--force`;
- rejects `--watch` and `--repo-id`;
- requires an absolute, non-existent target path;
- rejects a target equal to the configured active database;
- calls the existing cross-platform `findExistingProcess()` pidfile probe for
  the configured active database and rejects a live SDL owner; stale pidfiles
  are removed by that helper;
- overrides graph-path environment variables only for the command lifetime;
- indexes every configured repository into the target with
  `isolatedRebuild: true`;
- treats any repository failure as candidate failure;
- waits for every repository's background graph-integrity verifier to quiesce
  and requires its current state to be `verified`;
- checkpoints and closes the candidate;
- reopens the same candidate;
- validates it; and
- closes it again before reporting success.

The pidfile probe detects supported SDL-MCP owners on every platform; it cannot
prove that an unrelated process opened LadybugDB directly. The command therefore
also reports the explicit operator precondition that no unsupported external
LadybugDB owner may be running. It does not open the active database to test
ownership, update configuration, or delete either database. Its success output
identifies the validated candidate and tells the operator that activation still
requires a stopped-server path switch.

### Candidate validation

Before checkpoint/close, the command awaits
`waitForGraphIntegrityVerifier(repoId)` for each configured repository and
rejects a `failed` or still-`verifying` state. After reopen, validation requires:

- global physical Symbol count equals distinct `symbolId` count;
- no duplicate sample groups;
- each non-empty configured repository has persisted files, a latest Version,
  and a verified current graph-integrity revision;
- a valid empty configured repository is present and has no contradictory
  persisted graph state;
- repository Symbol membership counts contain no duplicate `symbolId`;
- deterministic scan samples agree with primary-key point lookup;
- `LOWER()` succeeds across canonical string fields;
- all `DEPENDS_ON` relationship endpoints expose non-empty Symbol IDs;
- when FTS is enabled, the configured Symbol FTS index exists and a bounded
  `QUERY_FTS_INDEX` probe executes successfully.

Validation errors are typed and retain the candidate for diagnosis. They never
fall through to activation.

### Saved-file placeholder canonicalization

The saved-file path currently constructs new fileless manifest symbols with
`canonicalizeDependencyPlaceholders: false`. Replace the alternate shape with
one pure `canonicalDependencyPlaceholderSymbol()` builder shared by edge
writes, physical normalization, and manifest construction.

Before applying the manifest delta in the same saved-file transaction:

1. write the file, symbols, references, and parser-owned edges;
2. call the existing `normalizeDependencyPlaceholderSymbols()` helper scoped
   to the durable file for file-backed repairs and to the touched placeholder
   `symbolIds` for fileless repairs;
3. let that helper canonicalize only those touched unresolved fileless
   dependency placeholders;
4. apply the canonical manifest delta; and
5. advance the integrity revision.

When a touched unresolved placeholder already has a repo-local manifest row,
the newly constructed canonical placeholder takes precedence over the stale
manifest JSON. This updates both legacy blank expectations and shared
cross-repository placeholders without reconstructing the expectation from the
post-write database.

No second placeholder normalizer is introduced.

### Background verification coalescing

Saved-file patches may commit while the current Version is `verifying`; graph
reads remain available and the worker coalesces revisions.

The no-op incremental path must not interpret a currently running verifier as
a missing baseline. Add a non-cancelling `waitForGraphIntegrityVerifier(repoId)`
operation that:

- starts the durable recovery worker if a pending revision lost its wakeup;
- awaits the current per-repository worker;
- lets the worker coalesce to the latest revision; and
- returns after the worker has published either verified or failed state.

Both no-op incremental call sites await this operation before running the
existing independent digest check. A verified result continues. A failed result
raises the typed permanent baseline error and does not request another full
refresh automatically.

Foreground saved-file reconciliation still does not wait for the verifier.

### Watcher fallback and retry classification

`processWatchedFileChange()` currently converts every patch error into a
repo-wide incremental refresh. The outer watcher then retries every resulting
error. This transforms deterministic integrity failures into repeated SCIP
generation and refresh attempts.

Change the rules:

- fall back from a saved-file patch to incremental indexing only for a proven
  missing path (`ENOENT` or `ENOTDIR`), which represents delete/rename;
- rethrow all other patch errors;
- retry boundedly only for recognized transient writer/read-pool contention;
- never retry `StorageIntegrityError`, `SafeRebuildRequiredError`,
  graph-baseline errors, manifest-validation errors, parse/config errors, or
  unknown failures; and
- preserve the existing timeout rule that never spawns work behind an
  uncancelled timed-out attempt.

The watcher remains stale and records bounded recovery guidance after a
permanent failure, but it does not launch another refresh loop.

### Audit serialization

The existing post-index session buffer covers finalization but not the earlier
provider materialization boundary. Do not bind audit buffering to the generic
indexing gate, because that gate also covers ordinary incremental work and is
not a database-ownership boundary.

Add an explicit nest-safe audit buffering scope around a full refresh. While
the scope is active, `recordAuditEvent()` uses the existing bounded 5,000-row
buffer. On scope exit it drains once through the serialized writer after the
full-refresh body has settled.

Also serialize `drainAuditBuffer()` itself with one module-local promise tail,
with the empty check inside the queued section. This prevents session-end,
full-refresh-end, and shutdown drains from racing each other.

The same scope can later bracket an online database handoff. This change does
not claim to implement hot multi-repository activation.

## Error model

Add three explicit permanent error types:

- `StorageIntegrityError`: physical primary-key incoherence;
- `SafeRebuildRequiredError`: a destructive active full refresh was refused;
- `GraphIntegrityBaselineError`: the current Version lacks a verified usable
  baseline.

All retain existing public error-code compatibility by extending the current
database/index error classes. Watcher classification uses the concrete types,
not recovery-message text.

Transient classification may inspect the concrete concurrency timeout classes
and the known Ladybug single-writer conflict through a bounded `cause` chain.
Unknown errors are not assumed retryable.

## Recovery procedure

1. Stop every SDL process that could own the configured database.
2. Resolve the effective config and graph path, including environment
   overrides.
3. Copy the database and every existing WAL/checkpoint sidecar to a timestamped
   quarantine directory.
4. Record SHA-256 hashes for source and copied files.
5. Build the fixed SDL-MCP branch.
6. Run `sdl-mcp index --force --safe-rebuild <new-absolute-path>` using the
   production configuration.
7. Accept the candidate only if post-reopen validation succeeds.
8. While SDL remains stopped, update both config and launcher environment
   provenance to the candidate path.
9. Start SDL against that exact path.
10. Run live repo status, Symbol lookup, FTS search, graph retrieval, and
    integrity checks for every configured repository.
11. Retain the original database family and candidate build logs.

## Verification

### Focused regressions

- A mocked corrupt physical/distinct count raises `StorageIntegrityError` with
  a bounded duplicate sample.
- Index preflight occurs before SCIP invocation and any full-index write.
- A populated full refresh raises `SafeRebuildRequiredError`; an isolated
  candidate and a fresh first index remain allowed.
- `--safe-rebuild` parsing and validation reject watch, repo filtering,
  relative/equal/existing targets, and missing `--force`.
- Candidate validation runs only after close/reopen and rejects duplicate
  Symbol identity or unverified repository integrity.
- A cross-repository saved-file patch touches an already canonical shared
  placeholder and leaves physical and manifest digests equal.
- A legacy blank placeholder expectation is promoted to the canonical tuple in
  the same revision.
- A no-op incremental waits for a pending verifier and does not manufacture a
  full-refresh instruction while verification is in flight.
- Permanent watcher failures produce zero incremental fallbacks and zero
  retries.
- Permanent sync fallback failures consume zero retry budget and do not launch
  a second full-index attempt.
- Repeated benchmark full-index samples require a process-owned graph family
  that was absent before the command started.
- Missing-file patch failures produce one incremental fallback.
- Known writer contention retains bounded retry.
- Audit events emitted during full indexing remain buffered and drain without
  a competing write transaction.
- Concurrent audit drain requests serialize.

### Repository verification

Run:

```powershell
npm run build:all
node --experimental-strip-types --test `
  tests/unit/ladybug-symbol-queries.test.ts `
  tests/unit/persisted-graph-integrity.test.ts `
  tests/unit/watcher-save-fallback.test.ts `
  tests/unit/cli-index-command.test.ts `
  tests/integration/saved-file-graph-patch.test.ts `
  tests/integration/audit-buffer-end-hook-drain.test.ts
npm run typecheck
npm run lint
npm test
```

The final recovery adds candidate and live-system validation evidence. A green
test suite alone is not sufficient to activate a database.

## Documentation

Update:

- CLI help and indexing documentation for `--safe-rebuild`;
- configuration/recovery documentation with the stopped-server switch;
- graph-integrity guidance so `failed` state directs operators to safe rebuild,
  not deletion of the configured database; and
- the background integrity design's full-index ownership statement to point to
  this whole-database boundary.

## Non-goals

- In-place repair of duplicate primary keys.
- Raising or bypassing LadybugDB's 2,048-row shadow mutation guard.
- Hot-switching a live multi-repository embedded database.
- Automatically editing configuration from the rebuild command.
- Automatically deleting failed candidates or quarantined evidence.
- Rebuilding derived semantic data after every saved edit.
- Retrying deterministic integrity failures in the background.
