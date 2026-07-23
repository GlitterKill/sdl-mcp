# Graph Integrity Safe Recovery Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents are explicitly requested) or superpowers:executing-plans to
> implement this plan. Follow red-green-refactor and keep each checkbox current.

**Goal:** Recover the configured multi-repository graph into a verified fresh
LadybugDB database and prevent corrupt storage, non-atomic active full refreshes,
placeholder drift, watcher retry loops, and audit write races from recurring.

**Architecture:** Fail closed before SCIP or writes when physical Symbol
identity is incoherent or a populated active database receives a destructive
full refresh. Add an offline whole-configured-database safe-rebuild command that
builds a non-existent target, waits for background verification, checkpoints,
closes, reopens, and validates it without changing configuration. Make
save-time placeholder storage and manifest tuples share one canonical builder,
wait for in-flight verification before no-op checks, classify watcher failures
by typed cause, and serialize audit-buffer drains.

**Tech Stack:** TypeScript, Node.js `node:test`, LadybugDB
`@ladybugdb/core@0.18.1`, SCIP providers, Windows PowerShell recovery tooling.

**Design:** [Graph Integrity Safe Recovery and Background Reconciliation](../specs/2026-07-23-graph-integrity-safe-recovery-design.md)

---

## File Map

- Modify `src/domain/errors.ts`: add permanent storage, rebuild-required, and
  graph-baseline error types.
- Add `src/db/symbol-placeholders.ts`: define the single canonical dependency
  placeholder builder.
- Modify `src/db/ladybug-symbols.ts`: add global physical-identity inspection
  and touched-placeholder normalization.
- Modify `src/db/ladybug-edges.ts`: persist placeholders through the canonical
  builder.
- Modify `src/indexer/provider-first/persisted-graph-integrity.ts`: share the
  canonical builder, prefer newly touched placeholders, and raise a typed
  baseline error.
- Modify
  `src/indexer/provider-first/background-graph-integrity-verifier.ts`: expose a
  non-cancelling quiescence waiter.
- Modify `src/live-index/file-patcher.ts`: canonicalize touched placeholders in
  the saved-file transaction.
- Add `src/indexer/index-storage-preflight.ts`: keep health and destructive-full
  guards out of the near-budget `indexer.ts`.
- Modify `src/indexer/indexer.ts`: run preflight before SCIP/writes, await
  verifier quiescence for no-op checks, and bracket full refresh audit writes.
- Modify `src/indexer/watcher.ts`: run startup health checks and classify patch
  fallback/retry behavior by bounded typed cause.
- Modify `src/mcp/audit-buffer.ts` and `src/mcp/telemetry.ts`: add an explicit
  full-refresh buffering scope and serialize drains.
- Modify `src/cli/types.ts`, `src/cli/argParsing.ts`, and `src/cli/index.ts`:
  parse and advertise `--safe-rebuild`.
- Add `src/cli/commands/index-safe-rebuild.ts`: validate candidate paths,
  enforce ownership preconditions, rebuild all configured repositories, and
  validate after reopen.
- Modify `src/cli/commands/index.ts`: invoke the safe-rebuild lifecycle and pass
  the internal isolated-candidate option.
- Modify focused unit/integration tests named below.
- Modify operator/indexing documentation, `CHANGELOG.md`, and public CLI help.

## Chunk 1: Fail-Closed Storage and Refresh Admission

### Task 1: Add typed errors and global Symbol identity inspection

**Files:**
- Modify: `src/domain/errors.ts`
- Modify: `src/db/ladybug-symbols.ts`
- Modify: `src/db/ladybug-queries.ts` only if the barrel does not already
  export the symbols module
- Test: `tests/unit/ladybug-symbol-queries.test.ts`

- [ ] **Step 1: Write failing storage-integrity tests**

Cover a healthy global label count and a mismatched physical/distinct count.
Assert that the mismatch query requests a deterministic bounded sample ordered
by `symbolId`, converts Ladybug bigint aggregates, and raises
`StorageIntegrityError`.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/ladybug-symbol-queries.test.ts
```

Expected: fail because the inspection API and typed error do not exist.

- [ ] **Step 3: Implement the minimum inspection API**

Use the global `MATCH (s:Symbol)` scan with
`count(s)`/`count(DISTINCT s.symbolId)`. Do not traverse relationships or scope
by repository. Fetch duplicate groups only after a mismatch and cap the sample.

- [ ] **Step 4: Re-run the focused test and confirm GREEN**

### Task 2: Guard indexing before provider work or mutation

**Files:**
- Add: `src/indexer/index-storage-preflight.ts`
- Modify: `src/indexer/indexer.ts`
- Modify: `src/indexer/types.ts` or the existing `IndexRepoOptions` owner
- Test: `tests/integration/provider-first-scip-execution.test.ts`
- Test: `tests/integration/full-index-verifier-quiescence.test.ts`

- [ ] **Step 1: Add failing admission regressions**

Prove physical corruption prevents SCIP invocation and all graph writes. Prove
a populated explicit full refresh raises `SafeRebuildRequiredError`, while a
fresh first index and `isolatedRebuild: true` remain admitted.

- [ ] **Step 2: Run the two focused tests and confirm RED**

- [ ] **Step 3: Implement preflight ahead of SCIP**

Keep the helper in the new module so `src/indexer/indexer.ts` remains below its
line-budget regression. Determine population from persisted graph state, not
source-disk contents.

- [ ] **Step 4: Re-run the focused tests and confirm GREEN**

## Chunk 2: Durable Saved-File Reconciliation

### Task 3: Canonicalize physical and manifest placeholder tuples together

**Files:**
- Add: `src/db/symbol-placeholders.ts`
- Modify: `src/db/ladybug-symbols.ts`
- Modify: `src/db/ladybug-edges.ts`
- Modify:
  `src/indexer/provider-first/persisted-graph-integrity.ts`
- Modify: `src/live-index/file-patcher.ts`
- Test: `tests/unit/persisted-graph-integrity.test.ts`
- Test: `tests/integration/saved-file-graph-patch.test.ts`

- [ ] **Step 1: Add failing canonicalization regressions**

Cover a touched placeholder already canonicalized by another repository and a
legacy blank repo-local manifest row. Assert canonical stable fields in physical
storage and the manifest digest after commit/reopen.

- [ ] **Step 2: Run both tests and confirm RED with digest mismatch**

- [ ] **Step 3: Add one pure canonical builder**

Return the existing canonical ID/name/fingerprint, unknown kind/language, zero
ranges, null signature/SCIP, treesitter source, and unresolved classification.
Reuse it in edge persistence, normalization, and manifest construction.

- [ ] **Step 4: Scope save-time fileless normalization**

Extend the existing normalizer with optional touched `symbolIds`. Within the
saved-file transaction, normalize file-backed rows by file and only touched
fileless placeholders by ID before applying the manifest delta. Prefer the
newly constructed canonical tuple over stale manifest JSON.

- [ ] **Step 5: Re-run both tests and confirm GREEN**

## Chunk 3: Background Verification and Watcher Liveness

### Task 4: Wait for coalesced verification before no-op integrity checks

**Files:**
- Modify:
  `src/indexer/provider-first/background-graph-integrity-verifier.ts`
- Modify:
  `src/indexer/provider-first/persisted-graph-integrity.ts`
- Modify: `src/indexer/indexer.ts`
- Test: `tests/integration/full-index-verifier-quiescence.test.ts`
- Test: `tests/unit/persisted-graph-integrity.test.ts`

- [ ] **Step 1: Add a failing in-flight verifier regression**

Commit a saved-file revision, hold its verifier, request a no-op incremental
index, and prove the operation waits rather than emitting full-refresh recovery
guidance. Add a failed-baseline assertion for `GraphIntegrityBaselineError`.

- [ ] **Step 2: Run the focused tests and confirm RED**

- [ ] **Step 3: Implement non-cancelling quiescence**

Expose `waitForGraphIntegrityVerifier(repoId)` without cancelling useful work.
Await it at both no-op verification sites. Task 8 consumes the exported waiter
at the later candidate-finalization boundary.

- [ ] **Step 4: Re-run the focused tests and confirm GREEN**

### Task 5: Stop watcher fallback and retry amplification

**Files:**
- Modify: `src/indexer/watcher.ts`
- Test: `tests/unit/watcher-save-fallback.test.ts`

- [ ] **Step 1: Add failing classifier and behavior tests**

Cover permanent typed storage/baseline/provider replacement errors, a real
missing watched path (`ENOENT`/`ENOTDIR` whose error path identifies that watched
file), known transient writer contention, operation timeout, and unknown error.
Include wrapped causes and an unrelated nested missing-path error that must not
trigger fallback.

- [ ] **Step 2: Confirm RED**

Expected: the current catch-all starts incremental fallback and retry.

- [ ] **Step 3: Implement bounded cause classification**

Run storage and no-op integrity health checks before provider watcher startup.
Only errors proving that the watched path itself is missing receive one
incremental fallback. Retry only explicitly transient errors; mark permanent or
unknown failures stale without a timer loop.

- [ ] **Step 4: Re-run the watcher tests and confirm GREEN**

## Chunk 4: Writer Serialization

### Task 6: Buffer full-refresh audits and serialize drains

**Files:**
- Modify: `src/mcp/audit-buffer.ts`
- Modify: `src/mcp/telemetry.ts`
- Modify: `src/indexer/indexer.ts`
- Test: `tests/integration/audit-buffer-end-hook-drain.test.ts`

- [ ] **Step 1: Add failing concurrency regressions**

Prove audit events emitted during full indexing do not start a competing write.
Start two drains concurrently and assert maximum one insertion in flight and
exactly-once insertion of every accepted row.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Implement an explicit nest-safe scope and promise-tail drain**

Do not bind buffering to the generic indexing gate. Put the empty check inside
the queued drain critical section and preserve the existing 5,000-row bound.
Always exit the scope in `finally`.

- [ ] **Step 4: Re-run the audit test and confirm GREEN**

## Chunk 5: Offline Whole-Database Safe Rebuild

### Task 7: Parse and validate the safe-rebuild command boundary

**Files:**
- Modify: `src/cli/types.ts`
- Modify: `src/cli/argParsing.ts`
- Modify: `src/cli/index.ts`
- Add: `src/cli/commands/index-safe-rebuild.ts`
- Modify: `src/cli/commands/index.ts`
- Test: `tests/unit/cli-index-command.test.ts`

- [ ] **Step 1: Add failing option and path tests**

Reject missing `--force`, `--watch`, `--repo-id`, relative targets, existing
targets, and a target equal to the configured graph path. Reject a live SDL
owner through `findExistingProcess()`. Preserve an explicit warning that an
unsupported direct LadybugDB owner cannot be detected without opening active
storage.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Implement parsing and preflight**

Resolve every path before mutation. Override both graph-path environment
variables only for the command lifetime and restore them in `finally`. Never
open, modify, delete, or rename the active database.

- [ ] **Step 4: Re-run CLI tests and confirm GREEN**

### Task 8: Build, quiesce, reopen, and validate a candidate

**Files:**
- Modify: `src/cli/commands/index-safe-rebuild.ts`
- Modify: `src/cli/commands/index.ts`
- Test: `tests/integration/safe-rebuild-validation.test.ts`

- [ ] **Step 1: Add a failing disk-backed lifecycle regression**

Create two configured repositories, including a valid empty repository. Build a
new candidate, await verifiers, checkpoint/close/reopen, and assert validation
runs only after reopen. Cover build failure, duplicate identity, failed
integrity, and conditional FTS failures while proving the active sentinel
remains unchanged. For both build and post-reopen validation failures, assert
the candidate connection closes while candidate files remain available for
diagnosis.

- [ ] **Step 2: Confirm RED**

- [ ] **Step 3: Implement the candidate lifecycle**

Index every configured repo with `isolatedRebuild: true`. Stop on the first
failure and retain the candidate. Await all verifiers and require verified
current revisions before checkpoint. Close, reopen, validate global uniqueness,
repo state, membership identity, scan/point lookup, canonical strings,
dependency endpoints, and enabled FTS; close again before success output.
Place connection teardown in `finally` across indexing, verifier, checkpoint,
reopen, and validation failures. Never remove a failed candidate.

- [ ] **Step 4: Re-run the lifecycle regression and confirm GREEN**

## Chunk 6: Documentation, Recovery, and Independent Verification

### Task 9: Update public and operator documentation

**Files:**
- Modify: CLI help source associated with `sdl-mcp index`
- Modify: `docs/configuration-reference.md`
- Modify: the existing indexing/recovery or troubleshooting guide selected by
  the implementation
- Modify: `docs/superpowers/specs/2026-07-20-background-graph-integrity-verification-design.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document fail-closed behavior and safe rebuild**

Explain why populated active full refreshes are refused, exact candidate
preconditions, quiescence/reopen validation, manual stopped-server cutover,
retention of the old database family, and the unsupported external-owner
precondition.

- [ ] **Step 2: Document foreground reconciliation**

State that save-time physical and manifest placeholder updates are atomic,
background verification is coalesced, and permanent health failures stop
watcher retry amplification.

- [ ] **Step 3: Run documentation link/format checks available in the repo**

### Task 10: Verify code before touching production configuration

**Files:**
- Test: all focused tests from Tasks 1–8
- Test: full repository suite

- [ ] **Step 1: Run fresh focused verification**

```powershell
npm run build:all
node --experimental-strip-types --test `
  tests/unit/ladybug-symbol-queries.test.ts `
  tests/unit/persisted-graph-integrity.test.ts `
  tests/unit/watcher-save-fallback.test.ts `
  tests/unit/cli-index-command.test.ts `
  tests/integration/saved-file-graph-patch.test.ts `
  tests/integration/provider-first-scip-execution.test.ts `
  tests/integration/full-index-verifier-quiescence.test.ts `
  tests/integration/audit-buffer-end-hook-drain.test.ts `
  tests/integration/safe-rebuild-validation.test.ts
npm run typecheck
npm run lint
```

- [ ] **Step 2: Run the full serial suite**

```powershell
npm test
```

Expected: every test passes with the Windows FTS runtime provisioned; no skip is
accepted for a regression that requires a real LadybugDB fixture.

- [ ] **Step 3: Request independent code and LadybugDB review**

Resolve every correctness or safety blocker and rerun affected verification.

### Task 11: Build and activate the production replacement safely

**Files:**
- Preserve:
  `F:\Claude\sdl-mcp\quarantine\graph-integrity-incident-20260723-095445`
- Create: a new explicit sibling `.lbug` candidate path
- Modify after validation only:
  `F:\Claude\sdl-mcp\sdlmcp.config.json`
- Modify after validation only:
  `F:\Claude\sdl-mcp\start-sdl-mcp-http.ps1`

- [ ] **Step 1: Reconfirm SDL is stopped and provenance is unchanged**

Re-resolve `SDL_CONFIG`, `SDL_GRAPH_DB_PATH`, config path, pidfile, launcher,
and hashes of the preserved source/copies.

- [ ] **Step 2: Run the built safe-rebuild command**

Use the production configuration and a non-existent timestamped candidate.
Capture the complete log and reject the candidate unless post-reopen validation
succeeds for all four configured repositories.

- [ ] **Step 3: Switch exact path provenance while stopped**

Use surgical, recoverable edits to config and launcher. Keep the original graph
family and all sidecars untouched. Record the exact pre-cutover config and
launcher bytes so rollback is deterministic.

- [ ] **Step 4: Start SDL and perform live checks**

For every configured repository, validate registration/status, current verified
integrity, Symbol lookup, graph retrieval, and enabled FTS. Exercise a real
saved-file reconciliation and confirm the agent-facing graph remains available
while the verifier settles in the background. Precondition the probe with the
file's exact contents/hash and restore those exact contents after verification.
Wait for the restoration patch to reconcile, then require its resulting current
integrity revision to reach `verified` before accepting the live cutover.

If startup or any live check fails, stop SDL before restoring the exact
pre-cutover config and launcher bytes, restart only after provenance is
consistent, and retain both old and candidate database families plus logs.

- [ ] **Step 5: Re-run final repository verification**

Run focused tests plus `npm test` again if any source changed after the previous
full pass. Record exact counts, candidate path, hashes, and remaining risks in
the handoff.
