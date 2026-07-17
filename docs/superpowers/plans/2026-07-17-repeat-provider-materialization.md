# Repeat Provider Materialization Safety Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeat provider-first materialization from using `COPY Symbol` after deleting existing provider rows while preserving edge rebuilding and fresh-index performance.

**Architecture:** Keep materialization capabilities separate in `ProviderFirstActiveMaterializationPlan`: row deletion, known-fresh symbol writing, and edge writing are independent decisions. Only a database with no pre-existing provider rows qualifies for known-fresh `COPY`; a small repeat run deletes stale rows, merge-upserts symbols, and recreates edges.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, GitHub Actions.

---

## Chunk 1: Regression and minimal fix

### Task 1: Lock the repeat-run plan contract

**Files:**
- Modify: `tests/unit/provider-first-indexing.test.ts`

- [ ] Change the small-repeat expectation to `useKnownFreshWriters: false` while keeping deletion and edge writes enabled.
- [ ] Run the focused test and confirm it fails because the current planner returns `true`.

### Task 2: Decouple writer freshness from edge rebuilding

**Files:**
- Modify: `src/indexer/indexer-pass1-policy.ts`

- [ ] Set `useKnownFreshWriters` only when no provider rows existed.
- [ ] Set `writeEdges` when the graph is fresh or stale provider rows were deleted.
- [ ] Add a short comment documenting why deletion does not make LadybugDB safe for primary-key `COPY`.
- [ ] Run the focused test and confirm it passes.

### Task 3: Prove the selected materializer path

**Files:**
- Modify: `tests/unit/provider-first-indexing.test.ts`

- [ ] Add or adapt a materializer regression for delete + merge-safe symbol upsert + generic edge creation.
- [ ] Run it first against the old option combination if needed to prove the assertion catches `COPY`.
- [ ] Run the focused provider-first suite and confirm it passes.

## Chunk 2: Documentation and verification

### Task 4: Record the CI finding

**Files:**
- Modify: `.github/workflows/AGENTS.md`

- [ ] Add the run, job attempts, exact error, eliminated cache hypotheses, root cause, fix, and verification commands.

### Task 5: Verify locally and on hosted Ubuntu

**Files:**
- No production files beyond the ones listed above.

- [ ] Run the focused provider-first test file.
- [ ] Run typecheck and lint.
- [ ] Run the locked benchmark guardrail locally if practical.
- [ ] Inspect `git diff --check` and the final diff.
- [ ] Rerun failed jobs for run `29580560720` and confirm the benchmark job succeeds on hosted Ubuntu.
