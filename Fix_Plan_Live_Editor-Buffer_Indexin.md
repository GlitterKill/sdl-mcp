 Fix Plan: Live Editor-Buffer Indexing Code Review Issues

 Context

 Code review of the live editor-buffer indexing feature (pending uncommitted changes) found 18 issues: 3 critical, 8
 medium, 7 low. This plan fixes all of them across 5 phases, starting with the 3 critical security/safety issues.

 ---
 Phase 1: Critical Security & Safety (C1, C2, C3)

 C1. Path traversal vulnerability

 Problem: draft-parser.ts:82 and file-patcher.ts:41 call normalizePath() + join() without validating the result stays
 within the repo root. A crafted filePath like ../../etc/passwd escapes the repo boundary.

 Existing safe helpers in src/util/paths.ts (lines 71-111): getAbsolutePathFromRepoRoot() and validatePathWithinRoot()
 — already handle this correctly.

 Changes:

 1. src/live-index/draft-parser.ts:
   - Remove import { join } from "path" (line 1)
   - Add getAbsolutePathFromRepoRoot to the paths.ts import (line 23)
   - Replace line 129: join(input.repoRoot, relPath) → getAbsolutePathFromRepoRoot(input.repoRoot, relPath)
 2. src/live-index/file-patcher.ts:
   - Remove import { join } from "path" (line 1)
   - Add getAbsolutePathFromRepoRoot to the paths.ts import (line 7)
   - Replace line 52: join(repo.rootPath, relPath) → getAbsolutePathFromRepoRoot(repo.rootPath, relPath)
 3. src/mcp/tools.ts (defense-in-depth at Zod schema, ~line 648):
   - Add .refine() to BufferPushRequestSchema.filePath:
   filePath: z.string().min(1).refine(
   (p) => !p.includes(".."),
   { message: "filePath must not contain path traversal sequences" },
 ),

 C2. Unbounded recursive frontier expansion

 Problem: reconcile-worker.ts drain() while-loop (lines 36-84) re-enqueues frontiers from patched files with no cycle
 detection. A→B→A creates an infinite loop.

 Changes in src/live-index/reconcile-worker.ts:

 1. Add constant: const MAX_DRAIN_ITERATIONS = 500;
 2. In drain(), add visitedFiles = new Set<string>() and iterations counter before the while loop
 3. Inside the file loop, build fileKey = \${repoId}:${filePath}`, skip if visitedFiles.has(fileKey), add to set,
 increment iterations`
 4. Break outer while loop if iterations >= MAX_DRAIN_ITERATIONS with a stderr warning

 C3. Expensive cluster/process recomputation

 Problem: computeAndStoreClustersAndProcesses() (full graph traversal) runs on every reconcile batch when ANY symbol is
  touched (lines 66-74).

 Changes in src/live-index/reconcile-worker.ts:

 1. Import createDebouncedJobScheduler from ./debounce.js
 2. Add a clusterScheduler field (5000ms delay) that calls computeAndStoreClustersAndProcesses
 3. Replace inline cluster computation block with void this.clusterScheduler.schedule(repoId, ...)
 4. Update waitForIdle() to also await this.clusterScheduler.waitForIdle()

 ---
 Phase 2: Debounce & Scheduler Reliability (M1, M2)

 M1. Debounce orphans old completion Promises

 Problem: debounce.ts:18-19 clears the timer but never resolves the old Promise. Callers hang forever. Also: no error
 propagation when run() throws.

 Changes in src/live-index/debounce.ts:

 1. Add rejectCompletion to PendingJob<T> type
 2. After clearTimeout(existing.timer), call existing.resolveCompletion() to unblock old waiters
 3. Create Promise with both resolve and reject paths
 4. In setTimeout callback: resolve on success, reject on error (replace silent finally block)
 5. Include rejectCompletion in jobs.set()

 M2. reset() doesn't cancel pending parse jobs

 Problem: coordinator.ts:243-247 clears overlay store but doesn't cancel the parseScheduler. In-flight parses resurrect
  stale entries.

 Changes:

 1. src/live-index/debounce.ts: Add cancelAll() method — clears all timers, resolves all pending Promises, clears the
 jobs map. Add to returned scheduler object.
 2. src/live-index/coordinator.ts: In reset(), call this.parseScheduler.cancelAll() before clearing overlay store.

 ---
 Phase 3: Checkpoint & Idle Monitor Fixes (M3, M4, M5, M6)

 M3. Wasteful markCheckpointed + removeDraft

 File: src/live-index/checkpoint-service.ts (lines 70-75)

 Remove the markCheckpointed() call since the draft is immediately deleted by removeDraft() on the next line. Track
 lastCheckpointAt from this.now() directly.

 M4. No concurrency guard on checkpoint

 File: src/live-index/checkpoint-service.ts

 Add private readonly checkpointInProgress = new Set<string>(). At start of checkpointRepo(), return early with
 requested: false if repo already in progress. Wrap body in try/finally to remove from set. Clear the set in clear().

 M5. Idle monitor swallows errors

 File: src/live-index/idle-monitor.ts (line 35)

 Replace void this.scanOnce() with .catch() that writes to stderr.

 M6. No overlapping scan guard

 File: src/live-index/idle-monitor.ts

 Add private scanning = false. At top of scanOnce(), return [] if scanning. Set true, wrap body in try/finally.

 ---
 Phase 4: Client & Type Safety (M7, M8)

 M7. No request timeout in VSCode client

 File: sdl-mcp-vscode/src/live-sync.js

 Add AbortController with 5000ms timeout to all fetch calls. Clear timeout in finally block.

 M8. as any cast in draft-parser

 File: src/live-index/draft-parser.ts (line 163)

 Replace as any with proper type narrowing (as unknown as <CorrectType>[]) or fix the underlying type to include
 nodeId.

 ---
 Phase 5: Low Priority (L1, L3, L4, L5, L6)

 ┌───────────────────────────┬───────────────────────────┬─────────────────────────────────────────────────────────┐
 │           Issue           │           File            │                           Fix                           │
 ├───────────────────────────┼───────────────────────────┼─────────────────────────────────────────────────────────┤
 │ L1. Duplicate checkpoint  │ checkpoint-service.ts:53  │ Add monotonic counter: ckpt-${Date.now()}-${counter++}  │
 │ IDs                       │                           │                                                         │
 ├───────────────────────────┼───────────────────────────┼─────────────────────────────────────────────────────────┤
 │ L3. Over-invalidation     │ dependency-frontier.ts:78 │ Only include clusters/processes when                    │
 │                           │                           │ dependentSymbolIds.size > 0                             │
 ├───────────────────────────┼───────────────────────────┼─────────────────────────────────────────────────────────┤
 │ L4. Queue unbounded       │ reconcile-queue.ts        │ Add MAX_QUEUE_ENTRIES = 10_000, trim when exceeded      │
 │ growth                    │                           │                                                         │
 ├───────────────────────────┼───────────────────────────┼─────────────────────────────────────────────────────────┤
 │ L5. Tree-sitter memory    │ draft-parser.ts           │ Call tree.delete() in a finally block after parsing     │
 ├───────────────────────────┼───────────────────────────┼─────────────────────────────────────────────────────────┤
 │ L6. Language derivation   │ coordinator.ts:48         │ Handle .d.ts, extensionless files with a small lookup   │
 └───────────────────────────┴───────────────────────────┴─────────────────────────────────────────────────────────┘

 Skipped (not bugs, separate refactoring tasks):
 - L2. getOverlaySnapshot() rebuild caching — performance optimization
 - L7. buildOverlayCardForSymbol duplication — works correctly

 ---
 Verification

 After each phase:
 1. npm run typecheck — no new type errors
 2. npm test — all existing + new tests pass

 After all phases:
 3. Manual: start sdl-mcp serve --http, push a buffer event with ../../etc/passwd via HTTP → should get 400
 4. Manual: verify sdl-mcp doctor shows live index runtime check passing