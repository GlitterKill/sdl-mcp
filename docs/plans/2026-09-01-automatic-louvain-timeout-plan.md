# Automatic Louvain Manual-Only Implementation Plan

> **For agentic workers:** REQUIRED: Use test-driven development and preserve
> unrelated worktree changes.

**Goal:** Prevent automatic Louvain from blocking LadybugDB while retaining the
low-level algorithm for a future explicit trigger.

**Architecture:** Enforce manual-only behavior in the shared automatic
algorithm-refresh normalization path. Reuse the existing disabled branch to
clear stale shadow clusters and report `disabled/manual-only`; remove the
failed timeout-specific plumbing.

**Tech Stack:** TypeScript, LadybugDB, Node.js `node:test`.

---

## Chunk 1: Automatic Manual-Only Contract

### Task 1: Prove automatic Louvain is never dispatched

**Files:**

- Modify: `tests/unit/cluster-orchestrator-unit.test.ts`
- Modify: `src/indexer/cluster-orchestrator.ts`
- Modify: `config/sdlmcp.config.schema.json`
- Modify: `config/sdlmcp.config.example.json`

- [x] Replace the timeout-path test with a test that supplies legacy
  `louvain.enabled: true`.
- [x] Run only that test and confirm RED because the injected runner is called.
- [x] Seed stale Louvain shadow data and assert automatic refresh removes it.
- [ ] Force normalized automatic Louvain to disabled.
- [ ] Change disabled diagnostics and shadow cleanup reason to `manual-only`.
- [ ] Change the schema and example defaults to `false` and document the
  compatibility-only field.
- [ ] Re-run the focused test and confirm GREEN.

## Chunk 2: Remove False Timeout Protection

### Task 2: Restore the low-level algorithm contract

**Files:**

- Modify: `src/db/ladybug-algorithms.ts`
- Modify: `src/types/ladybug.d.ts`
- Modify: `tests/unit/ladybug-algorithms.test.ts`

- [ ] Remove `queryTimeoutMs`, `setQueryTimeout`, and the timeout-order test.
- [ ] Keep `runLouvain` otherwise unchanged for the future explicit trigger.
- [ ] Run the focused algorithm test.

### Task 3: Restore the prior derived-refresh connection path

**Files:**

- Modify: `src/indexer/derived-refresh-queue.ts`
- Modify: `tests/unit/derived-refresh-queue.test.ts`

- [ ] Restore `getLadybugConn` and remove the timeout-isolation test.
- [ ] Keep queue admission, cancellation, the outer timeout, and write-heavy
  locking unchanged.
- [ ] Run the focused queue test.

## Chunk 3: Documentation and Verification

### Task 4: Verify the complete change

**Files:**

- Modify: `docs/plans/2026-09-01-automatic-louvain-timeout-design.md`
- Modify: `docs/plans/2026-09-01-automatic-louvain-timeout-plan.md`

- [ ] Run the three focused unit-test files together.
- [ ] Run `npm run build:all`, `npm run typecheck`, and `npm run lint`.
- [ ] Run `git diff --check` and inspect the scoped diff.
- [ ] Preserve unrelated changes in `src/indexer/indexer.ts`,
  `src/retrieval/health.ts`, and
  `tests/unit/retrieval-coverage-cache.test.ts`.
- [ ] Ask the user to restart the HTTP server.
- [ ] Verify startup recovery performs no automatic Louvain work; do not run
  `index.refresh` or `sdl-mcp index`.
