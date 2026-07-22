# Public Graph Retrieval Admission Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every public versioned code-graph read at one MCP boundary and quiesce verification across every effective full index.

**Architecture:** A pure exact-name classifier maps validated public tool envelopes to a repository ID or exclusion, and `MCPServer` invokes the existing availability assertion once before dispatch. `indexRepo` resolves effective mode before work and wraps the complete full operation in the existing ref-counted verifier quiescence helper.

**Tech Stack:** TypeScript, Zod, Node `node:test`, LadybugDB.

---

## Chunk 1: Public retrieval boundary

### Task 1: Declarative classifier

**Files:**
- Create: `src/mcp/public-graph-retrieval-admission.ts`
- Create: `tests/unit/public-graph-retrieval-admission.test.ts`

- [ ] Write exhaustive RED tests that enumerate every registered flat tool,
  gateway action, retrieve operation, workflow step, and file operation as
  gated or excluded. Assert exact matching and deterministic missing repo ID.
- [ ] Run the focused unit test and confirm the classifier is absent.

  ```powershell
  npm.cmd run build:runtime
  node --experimental-strip-types --test-concurrency=1 --test tests/unit/public-graph-retrieval-admission.test.ts
  ```

  Expected: FAIL because the classifier module/export is absent.
- [ ] Implement exact `Set`/`Record` mappings with no prefix or substring
  logic. Return a discriminated admission decision.
- [ ] Run the focused unit test and confirm it passes.

  ```powershell
  npm.cmd run build:runtime
  node --experimental-strip-types --test-concurrency=1 --test tests/unit/public-graph-retrieval-admission.test.ts
  ```

  Expected: all classifier cases pass.

### Task 2: Shared MCP dispatch admission

**Files:**
- Modify: `src/server.ts`
- Modify: `src/mcp/tools/symbol.ts`
- Modify: `src/mcp/tools/slice.ts`
- Modify: `tests/integration/graph-retrieval-availability.test.ts`
- Create: `tests/integration/public-graph-retrieval-admission.test.ts`

- [ ] Write RED disposable-DB MCP tests for denied and byte-identical verified
  symbol and slice responses through each flat, gateway, and workflow
  projection; both file preview and source-window operations; context; all six
  retrieve operations; code tools; delta; PR risk; and overview. Assert a
  classified missing repo ID never dispatches.
- [ ] Run the focused integration tests and confirm uncovered tools dispatch.

  ```powershell
  $env:SDL_GRAPH_DB_PATH = Join-Path $env:TEMP ("sdl-public-admission-red-{0}.lbug" -f [guid]::NewGuid())
  npm.cmd run build:runtime
  node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/integration/public-graph-retrieval-admission.test.ts tests/integration/graph-retrieval-availability.test.ts
  ```

  Expected: FAIL because uncovered public graph reads reach handlers.
- [ ] Invoke the classifier and `assertGraphRetrievalAvailable` after schema
  validation and before handler dispatch. Throw one deterministic typed error
  when a classified envelope lacks a repository ID.
- [ ] Remove symbol/slice handler-local guards so public calls query admission
  once and successful handler payloads remain unchanged.
- [ ] Run the focused integration and existing handler tests.

  ```powershell
  $env:SDL_GRAPH_DB_PATH = Join-Path $env:TEMP ("sdl-public-admission-green-{0}.lbug" -f [guid]::NewGuid())
  npm.cmd run build:runtime
  node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/unit/public-graph-retrieval-admission.test.ts tests/integration/public-graph-retrieval-admission.test.ts tests/integration/graph-retrieval-availability.test.ts tests/unit/symbol-get-cards.test.ts tests/unit/mcp-slice-refresh.test.ts
  ```

  Expected: all public-boundary and existing handler tests pass.

## Chunk 2: Effective full-index quiescence

### Task 3: Full-mode lifecycle boundary

**Files:**
- Modify: `src/indexer/indexer.ts`
- Create: `tests/integration/full-index-verifier-quiescence.test.ts`

- [ ] Write RED real-DB tests that block a verifier lease, start explicit
  legacy/direct full indexing, and prove destructive reset does not begin until
  cancellation closes the lease. Add incremental-upgraded-to-full, failure
  release, and ordinary incremental-unaffected cases.
- [ ] Run the focused integration test and confirm destructive work races the
  verifier on the original implementation.

  ```powershell
  $env:SDL_GRAPH_DB_PATH = Join-Path $env:TEMP ("sdl-full-quiescence-red-{0}.lbug" -f [guid]::NewGuid())
  npm.cmd run build:runtime
  node --experimental-strip-types --test-concurrency=1 --test tests/integration/full-index-verifier-quiescence.test.ts
  ```

  Expected: FAIL because destructive full reset starts before the verifier lease closes.
- [ ] Move effective-mode resolution before full work and wrap checkpoint,
  implementation, and synchronous verification in
  `withGraphIntegrityVerifierQuiesced`. Preserve ordinary incremental flow;
  retain nested shadow quiescence.
- [ ] Run the focused integration tests and prior provider-first regressions.

  ```powershell
  $env:SDL_GRAPH_DB_PATH = Join-Path $env:TEMP ("sdl-full-quiescence-green-{0}.lbug" -f [guid]::NewGuid())
  npm.cmd run build:runtime
  node --experimental-strip-types --test-concurrency=1 --test tests/integration/full-index-verifier-quiescence.test.ts tests/integration/provider-first-index-repo-fallback.test.ts tests/unit/background-graph-integrity-verifier.test.ts
  ```

  Expected: all full-index and verifier regressions pass.

## Chunk 3: Verification and delivery

### Task 4: Complete regression gates

**Files:**
- Verify all modified files and documentation.

- [ ] Run runtime build and typecheck.

  ```powershell
  npm.cmd run build:runtime
  npm.cmd run typecheck
  ```
- [ ] Run exact Task 7, public retrieval, full-index, prior Tasks 1–6,
  determinism, and golden suites serially with disposable database paths.

  ```powershell
  $env:SDL_GRAPH_DB_PATH = Join-Path $env:TEMP ("sdl-task7-final-{0}.lbug" -f [guid]::NewGuid())
  node --experimental-strip-types --experimental-test-module-mocks --test-concurrency=1 --test tests/integration/determinism.test.ts tests/integration/repo-unregister.test.ts tests/integration/public-graph-retrieval-admission.test.ts tests/integration/graph-retrieval-availability.test.ts tests/integration/full-index-verifier-quiescence.test.ts tests/unit/background-graph-integrity-verifier.test.ts tests/unit/derived-state-startup-recovery.test.ts tests/unit/ladybug-repo-delete-exhaustive.test.ts tests/unit/repo-lifecycle.test.ts tests/unit/repo-status-health.test.ts tests/unit/shutdown-manager.test.ts tests/unit/sync-artifact.test.ts
  node --experimental-strip-types --test-concurrency=1 --test tests/integration/background-graph-integrity-snapshot.test.ts tests/integration/file-write-tool.test.ts tests/integration/provider-first-index-repo-fallback.test.ts tests/integration/provider-first-scip-execution.test.ts tests/integration/saved-file-graph-patch.test.ts tests/unit/background-graph-integrity-verifier.test.ts tests/unit/derived-state-startup-recovery.test.ts tests/unit/file-patcher.test.ts tests/unit/ladybug-connection.test.ts tests/unit/ladybug-derived-state-revisions.test.ts tests/unit/ladybug-graph-integrity-manifest.test.ts tests/unit/migration-fresh-db.test.ts tests/unit/migration-graph-integrity.test.ts tests/unit/persisted-graph-integrity.test.ts tests/unit/provider-first-indexing.test.ts tests/unit/watcher-save-fallback.test.ts
  npm.cmd run test:golden
  ```

  Expected: zero failures.
- [ ] Run lint and confirm zero new warnings/errors.

  ```powershell
  npm.cmd run lint
  ```
- [ ] Run `git diff --check` and audit every changed line against the spec.

  ```powershell
  git diff --check
  git diff --stat
  git status --short
  ```
- [ ] Commit implementation separately from the design/spec commits and verify
  the worktree is clean.
