# Incremental FileSummary Embedding Backlog Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accumulate deferred FileSummary embedding work across small incremental indexes and make deferred Nomic work visible in delegated CLI output.

**Architecture:** Keep the current changed-file fast path. When its uncached count is below the HNSW rebuild threshold, `refreshFileSummaryEmbeddings` expands to repository-wide FileSummary hashes so prior deferred rows join the current batch. Reuse `IndexProgress.message` for deferred status and teach the existing per-model CLI renderer to display it.

**Tech Stack:** TypeScript, Node.js built-in test runner, LadybugDB, existing SDL-MCP progress transport.

---

## Chunk 1: Regressions and implementation

### Task 1: Prove deferred rows accumulate across incremental scopes

**Files:**
- Modify: `tests/integration/semantic-embedding.test.ts`
- Modify: `src/indexer/file-summary-embeddings.ts`

- [ ] **Step 1: Write the failing integration test**

Add a test that creates two uncached FileSummary rows, refreshes only `file1` with `rebuildMinUncachedRows: 3`, and expects `deferred: 2` because the repository backlog includes `file2`. Add `file3`, refresh only `file3`, and expect all three rows to embed.

- [ ] **Step 2: Build and verify the test fails**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/integration/semantic-embedding.test.ts
```

Expected: FAIL because the first scoped refresh reports one deferred row instead of two.

- [ ] **Step 3: Implement repository backlog expansion**

In `refreshFileSummaryEmbeddings`, reuse one candidate-building helper for scoped and repository-wide rows. Compute the threshold before the empty/deferral returns. When `fileIds` are present and the scoped uncached count is below the threshold, reload all FileSummary rows for the repository and recompute cached, missing, and uncached counts.

Keep the existing bootstrap bypass, checkpoint, HNSW drop/write/recreate path, and scoped fast path for batches already at or above the threshold.

- [ ] **Step 4: Verify the integration test passes**

Run the same build and focused integration test. Expected: PASS.

### Task 2: Report deferred model work through existing progress transport

**Files:**
- Modify: `tests/unit/cli-progress-rendering.test.ts`
- Modify: `src/indexer/file-summary-embeddings.ts`
- Modify: `src/cli/commands/index.ts`

- [ ] **Step 1: Write the failing CLI renderer test**

Render an embedding event with `substage: "fileSummaryEmbeddings"`, Nomic as the model, and `message: "33 deferred"`. Assert that output includes `Summary Embeddings:` and `nomic: 33 deferred`.

- [ ] **Step 2: Build and verify the renderer test fails**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/unit/cli-progress-rendering.test.ts
```

Expected: FAIL because the embeddings renderer ignores `IndexProgress.message`.

- [ ] **Step 3: Emit and render the deferred message**

Before returning a deferred FileSummary result, emit an embedding progress event containing the FileSummary substage, model, and `"<count> deferred"` message.

Extend `ProgressState.embeddingsByModel` with an optional message. Render message-bearing model segments as `<short-model>: <message>`; exclude those segments from percentage aggregation so non-TTY output prints the status immediately.

- [ ] **Step 4: Verify both focused regressions pass**

Run the build and both focused test files. Expected: PASS.

## Chunk 2: Documentation and verification

### Task 3: Document incremental FileSummary debounce behavior

**Files:**
- Modify: `docs/configuration-reference.md`
- Modify: `docs/feature-deep-dives/semantic-embeddings-setup.md`

- [ ] **Step 1: Document backlog accumulation and CLI status**

Explain that FileSummary vector updates debounce the risky HNSW rebuild until 50 uncached rows, small incremental scopes join the repository backlog, and the CLI reports deferred counts. Clarify that FTS remains current while vectors wait.

### Task 4: Run affected verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Detect the final changed-file set**

Run `git diff --name-only HEAD` and map it through the repository test-scope table.

- [ ] **Step 2: Run focused regressions**

Run:

```powershell
npm run build:runtime
node --experimental-strip-types --test-concurrency=1 --test tests/integration/semantic-embedding.test.ts tests/unit/cli-progress-rendering.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run required source verification**

Run:

```powershell
npm run typecheck
npm run test:harness
```

Expected: both commands exit successfully.

- [ ] **Step 4: Inspect the final diff**

Run `git diff --check` and review `git diff --stat`. Confirm no generated layout-cache or backup files remain.
