# Tool Call Performance Investigation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify and fix the root causes of elevated SDL-MCP tool latency so accurate results return faster across Code Mode and flat gateway tool calls.

**Architecture:** Treat this as a measurement-first performance regression investigation, not a blind optimization sweep. Add phase-level evidence at the tool boundary, isolate cold/warm behavior, compare against a known-good baseline, then optimize the few shared hot paths that dominate p95 and max latency.

**Tech Stack:** TypeScript 5.9, Node.js 24, MCP SDK, LadybugDB, SDL-MCP Code Mode (`sdl.context`, `sdl.workflow`, `sdl.file`), runtime execution, observability dashboard, stress harness.

**Implementation status (2026-05-12):** The first optimization pass landed phase-level diagnostics for `sdl.context`, `sdl.workflow`, `sdl.runtime.execute`, and `sdl.file`; observability aggregation for per-tool phases and LadybugDB query latency; safer LadybugDB stored-procedure materialization; stdio watcher deferral; and a lower-latency `sdl.context` default path. A same-server smoke sample for the earlier slow `sdl.context` query improved from about 49s on the first call to about 182ms cold and 133ms warm after deferring watcher startup and avoiding default semantic seeding.

---

## Context

Current dashboard sample:

| Tool | N | P95 | Errors |
| --- | ---: | ---: | ---: |
| `sdl.context` | 15 | 15.32s | 0 |
| `sdl.workflow` | 112 | 4.68s | 0 |
| `sdl.runtime.execute` | 93 | 2.71s | 0 |
| `sdl.file` | 167 | 1.65s | 0 |

Overall latency: avg 4.57s, p50 1.40s, p99 14.02s, max 120.14s.

Live observation while creating this plan: one `sdl.context` lookup took about 13.5s. Its retrieval evidence showed hybrid retrieval with about 1.9s fusion latency and thousands of FTS candidates. The SDL-MCP HTTP endpoint then stopped responding to follow-up MCP calls, so transport/server stability must be investigated alongside latency.

Important pushback: an "all tools" optimization pass should start with breadth-first instrumentation and attribution. Optimizing every handler manually before finding shared bottlenecks is likely to waste time and can regress accuracy. The high-leverage target is the common path: Code Mode validation, retrieval, DB calls, response shaping/packing, observability emission, and process/runtime overhead.

Use @systematic-debugging for the investigation and @verification-before-completion before claiming improvements.

## File Structure

Expected investigation touch points:

- Inspect: `src/code-mode/index.ts` for `sdl.workflow`, `sdl.context`, and `sdl.file` registration and top-level timing.
- Inspect: `src/code-mode/workflow-executor.ts` for step validation, reference resolution, ETag injection/extraction, transform overhead, and per-step timing.
- Inspect: `src/retrieval/orchestrator.ts` for FTS/vector candidate generation, fusion, PPR, and retrieval evidence timing.
- Inspect: `src/graph/slice.ts`, `src/graph/cache.ts`, and `src/graph/sliceCache.ts` for slice build and cache behavior.
- Inspect: `src/mcp/tools/code.ts`, `src/mcp/tools/symbol.ts`, `src/mcp/tools/slice.ts`, `src/mcp/tools/repo.ts`, and related flat handlers for shared tool overhead.
- Inspect: `src/runtime/*` and `src/mcp/telemetry.ts` for `runtime.execute` spawn, output capture, artifact persistence, and audit/telemetry writes.
- Inspect: `src/code-mode/file-gateway.ts` or the current `sdl.file` gateway implementation for read/write/search edit/preview paths.
- Inspect: `src/observability/service.ts`, `src/observability/aggregator.ts`, and `src/observability/event-tap.ts` for metric meaning and overhead.
- Inspect: `tests/stress/infra/*` and `tests/stress/scenarios/*` for reusable latency harnesses.
- Create or modify only after root cause evidence:
  - Focused unit tests under `tests/unit/` for timing metadata, cache behavior, and bug fixes.
  - Focused stress scenario updates under `tests/stress/` for p95/p99 regression coverage.
  - Docs updates in `docs/feature-deep-dives/observability-dashboard.md`, `docs/benchmark-guardrails.md`, and `CHANGELOG.md` if public metrics or operational guidance changes.

## Chunk 1: Baseline and Reproduction

### Task 1: Preserve the current state and define measurement rules

**Files:**
- Inspect: `CHANGELOG.md`
- Inspect: `docs/benchmark-guardrails.md`
- Inspect: `docs/feature-deep-dives/observability-dashboard.md`

- [ ] **Step 1: Confirm the working tree is clean or identify unrelated changes**

Run:

```bash
git status --short
```

Expected: either no output or a clear list of unrelated local changes to avoid touching.

- [ ] **Step 2: Capture current environment and configuration**

Run:

```bash
npm run build
npm run doctor
```

Expected: build passes and doctor reports the active config, performance tier, DB path, native addon status, and warnings.

- [ ] **Step 3: Capture observability snapshots before load**

Run against the active HTTP server:

```bash
curl -s http://127.0.0.1:3000/api/observability/snapshot
curl -s http://127.0.0.1:3000/api/observability/timeseries
```

Expected: JSON includes latency, retrieval, cache, DB, event loop, runtime, and per-tool metrics. If auth is enabled, add the configured bearer token.

- [ ] **Step 4: Record baseline acceptance criteria**

Write down cold and warm budgets separately. Do not use one global latency budget for all tools.

Initial proposed warning targets, to be finalized after baseline comparison:

| Tool path | Cold p95 warning | Warm p95 warning | Notes |
| --- | ---: | ---: | --- |
| `sdl.context` precise query | 5s | 2s | Accuracy cannot drop. Track retrieval source counts and final evidence quality. |
| `sdl.context` broad query | 8s | 4s | Broad prompts may do more work but should not hit 15s p95. |
| `sdl.workflow` no runtime step | 2s | 1s | Measure tool overhead separately from child tool work. |
| `sdl.runtime.execute` trivial command | 1s | 750ms | Measures SDL overhead beyond process execution. |
| `sdl.file` read/search preview | 1s | 500ms | Split non-indexed read, search edit, preview window, and source window. |

### Task 2: Reproduce the latency with controlled call sets

**Files:**
- Inspect: `tests/stress/scenarios/single-client-baseline.ts`
- Inspect: `tests/stress/scenarios/concurrent-readers.ts`
- Inspect: `tests/stress/scenarios/semantic-tools.ts`
- Inspect: `tests/stress/scenarios/search-edit-batch.ts`
- Inspect: `tests/stress/scenarios/mixed-read-write.ts`

- [ ] **Step 1: Run the existing single-client baseline**

Run the repo's stress command for `single-client-baseline`.

Expected: per-tool p50/p95/p99/max output and timing diagnostics, with no errors.

- [ ] **Step 2: Run focused scenarios for the current slow tools**

Run existing stress scenarios that cover:

- `sdl.context` retrieval.
- `sdl.workflow` multi-step calls.
- `sdl.runtime.execute` trivial and realistic commands.
- `sdl.file` read, search edit preview, preview window, and source window.

Expected: repeatable latency distributions. If the current scenarios do not isolate these cases, add a new scenario before optimizing.

- [ ] **Step 3: Split cold vs warm samples**

For each tool call shape, collect:

- first call after server start,
- repeated identical call,
- repeated semantically similar call,
- concurrent call,
- after index or cache invalidation.

Expected: the report separates cold setup, cache misses, cache hits, and concurrent contention.

- [ ] **Step 4: Reproduce the endpoint failure**

Run the same `sdl.context` prompt that triggered about 13.5s latency, then immediately call `sdl.action.search` or `/api/observability/snapshot`.

Expected: either server remains healthy or logs show why the MCP endpoint becomes unreachable.

## Chunk 2: Instrumentation and Attribution

### Task 3: Make timing diagnostics actionable

**Files:**
- Modify if needed: `src/observability/types.ts`
- Modify if needed: `src/observability/aggregator.ts`
- Modify if needed: `src/observability/service.ts`
- Modify if needed: `tests/unit/observability/aggregator.test.ts`
- Modify if needed: `tests/unit/stress-timing-diagnostics.test.ts`

- [ ] **Step 1: Verify current latency semantics**

Confirm whether dashboard latency starts at MCP request receipt and stops after serialization, or whether it excludes response shaping/packing.

Expected: documented answer with exact code path.

- [ ] **Step 2: Add or validate phase timing buckets**

Each tool call should be attributable to phases such as:

- validation,
- routing/action lookup,
- DB query time,
- retrieval candidate search,
- fusion/PPR,
- slice/code window construction,
- runtime process spawn,
- output capture/artifact persistence,
- response shaping/packing,
- observability/audit writes.

Expected: stress reports can explain why a p95 sample was slow.

- [ ] **Step 3: Preserve metric semantics**

If public observability payloads change, update docs and tests.

Expected: `docs/feature-deep-dives/observability-dashboard.md` matches the payload and clearly distinguishes total latency from phase timings.

### Task 4: Add DB and retrieval correlation

**Files:**
- Inspect/modify if needed: `src/db/ladybug-core.ts`
- Inspect/modify if needed: `src/db/ladybug-queries.ts`
- Inspect/modify if needed: `src/retrieval/orchestrator.ts`
- Inspect/modify if needed: `src/retrieval/ppr.ts`

- [ ] **Step 1: Trace slow call IDs across layers**

Attach a request/correlation ID to tool latency, DB latency, retrieval evidence, and stress diagnostics.

Expected: one slow `sdl.context` sample can be traced to the exact retrieval and DB phases.

- [ ] **Step 2: Record candidate counts and caps**

For each retrieval source, capture candidate count, post-filter count, top-k count, and time.

Expected: a broad FTS candidate explosion is visible as data, not inferred from logs.

- [ ] **Step 3: Measure DB queue/contention**

Capture read/write contention, transaction wait time, and slow query summaries where available.

Expected: distinguish CPU-bound retrieval from LadybugDB single-writer contention or slow reads.

## Chunk 3: Tool-by-Tool Root Cause Pass

### Task 5: Optimize `sdl.context` only after attribution

**Files:**
- Inspect/modify if needed: `src/retrieval/orchestrator.ts`
- Inspect/modify if needed: `src/graph/slice.ts`
- Inspect/modify if needed: `src/code/*`
- Inspect/modify if needed: `src/mcp/context-response-projection.ts`
- Inspect/modify if needed: `src/code-mode/context-wire-format.ts`

- [ ] **Step 1: Profile representative precise and broad prompts**

Use Node CPU profiles and stress diagnostics on cold and warm calls.

Expected: top frames identify whether time is in retrieval, DB, graph expansion, code rung generation, packing, or serialization.

- [ ] **Step 2: Check retrieval accuracy before changing limits**

Build a small quality set from `tests/benchmark/context-quality-cases.json` and current real prompts.

Expected: any candidate cap or ranking change must preserve expected symbols/evidence.

- [ ] **Step 3: Test high-leverage hypotheses one at a time**

Candidate hypotheses:

- Bound FTS candidate counts earlier for broad prompts.
- Skip vector/PPR work when exact identifiers or high-confidence FTS hits already satisfy the task.
- Cache normalized retrieval plans and stable prompt analysis.
- Singleflight identical concurrent retrieval calls.
- Avoid unnecessary hot-path/code-rung expansion when cards and skeletons satisfy the budget.
- Reduce response packing overhead for small or fallback payloads.

Expected: each change has a before/after p95 and quality comparison.

### Task 6: Optimize `sdl.workflow`

**Files:**
- Inspect/modify if needed: `src/code-mode/workflow-executor.ts`
- Inspect/modify if needed: `src/code-mode/workflow-parser.ts`
- Inspect/modify if needed: `src/code-mode/etag-cache.ts`
- Inspect/modify if needed: `src/code-mode/action-catalog.ts`

- [ ] **Step 1: Separate framework overhead from step execution**

Measure validation, reference resolution, action lookup, ETag handling, per-step execution, and result shaping.

Expected: a workflow with no expensive child step should have low and stable overhead.

- [ ] **Step 2: Exercise common workflow shapes**

Scenarios:

- one data transform,
- search then card,
- search then slice,
- runtime execute then query output,
- mixed workflow with ETag cache reuse.

Expected: timing diagnostics show which shape drives the 4.68s p95.

- [ ] **Step 3: Optimize common overhead**

Candidate hypotheses:

- Reuse prebuilt action maps and schema summaries consistently.
- Avoid repeated deep clone/serialization of large intermediate results.
- Fast-path `$0.results.0.symbolId` reference resolution.
- Preserve ETag cache gains without scanning large caches on every step.

Expected: p95 improves without changing workflow response shape.

### Task 7: Optimize `sdl.runtime.execute`

**Files:**
- Inspect/modify if needed: `src/runtime/*`
- Inspect/modify if needed: `src/mcp/telemetry.ts`
- Inspect/modify if needed: `src/runtime/response-artifacts.ts`
- Inspect/modify if needed: `tests/unit/runtime*.test.ts`

- [ ] **Step 1: Split process time from SDL overhead**

Benchmark trivial commands, short Node commands, long-running commands, output-heavy commands, and persisted-output commands.

Expected: diagnostics show spawn time, execution time, output capture time, artifact write time, and audit/telemetry time.

- [ ] **Step 2: Check output processing cost**

Measure minimal, summary, and query-term output modes.

Expected: large outputs do not dominate p95 when callers request minimal output.

- [ ] **Step 3: Optimize only confirmed overhead**

Candidate hypotheses:

- Stream and truncate output earlier.
- Avoid artifact hashing/writes unless output persistence is requested or required.
- Batch or defer audit writes safely.
- Cache runtime resolution where command/runtime config is stable.

Expected: no change to command correctness or timeout behavior.

### Task 8: Optimize `sdl.file`

**Files:**
- Inspect/modify if needed: `src/code-mode/index.ts`
- Inspect/modify if needed: current file gateway implementation under `src/code-mode/` or `src/mcp/`
- Inspect/modify if needed: `src/mcp/session-delta.ts`
- Inspect/modify if needed: `tests/unit/code-mode-tool-validation.test.ts`
- Inspect/modify if needed: `tests/unit/session-delta.test.ts`

- [ ] **Step 1: Split operation variants**

Measure separately:

- non-indexed read,
- targeted write,
- search edit preview,
- search edit apply,
- preview window,
- source window,
- delta response mode.

Expected: the 1.65s p95 is attributed to specific operations, not `sdl.file` as a lump.

- [ ] **Step 2: Check indexed-source policy overhead**

Preview/source windows call through proof-of-need gating. Measure policy checks, symbol lookup, and source extraction independently.

Expected: policy safety remains intact while repeated window calls benefit from cache/delta behavior.

- [ ] **Step 3: Optimize confirmed overhead**

Candidate hypotheses:

- Cache plan-handle metadata for preview/source windows.
- Avoid broad filesystem scans for targeted reads/writes.
- Bound search edit preview matches earlier.
- Improve session delta cache hit rate for repeated window reads.

Expected: no weakening of plan-bound source access or write preconditions.

### Task 9: Cover the remaining tool catalog

**Files:**
- Inspect/modify if needed: `src/code-mode/action-catalog.ts`
- Inspect/modify if needed: `src/gateway/router.ts`
- Inspect/modify if needed: `src/mcp/tools/*`
- Inspect/modify if needed: `tests/stress/scenarios/*`

- [ ] **Step 1: Build a tool taxonomy**

Group all actions by shared cost model:

- pure metadata/catalog,
- DB lookup,
- retrieval/semantic,
- graph/slice,
- source/code window,
- runtime/process,
- write/mutation,
- sync/indexing.

Expected: every tool has a scenario or representative benchmark.

- [ ] **Step 2: Run breadth-first latency checks**

For each group, run a small smoke benchmark to identify outliers.

Expected: optimization work is prioritized by p95/max and call volume, not alphabetically.

- [ ] **Step 3: Add regression guards for high-volume tools**

Add warning thresholds for latency regressions where tests are stable enough.

Expected: CI warns on performance drift without failing on normal runner variance unless a hard timeout is crossed.

## Chunk 4: Implementation Waves

### Task 10: Land instrumentation first

**Files:**
- Modify: observability and stress diagnostics files identified above.
- Test: `tests/unit/observability/aggregator.test.ts`
- Test: `tests/unit/stress-timing-diagnostics.test.ts`

- [ ] **Step 1: Write failing tests for phase timing semantics**

Expected: tests fail because missing phases or aggregation semantics are not yet implemented.

- [ ] **Step 2: Implement the smallest instrumentation change**

Expected: all tool calls can emit total and phase timing without changing existing public fields.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm run build
node --test tests/unit/observability/aggregator.test.ts
node --test tests/unit/stress-timing-diagnostics.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit instrumentation**

Run:

```bash
git add src tests docs CHANGELOG.md
git diff --cached --check
git commit -m "perf: add tool latency phase diagnostics"
```

### Task 11: Land hot-path fixes by measured priority

**Files:**
- Modify only the confirmed hot-path files from Tasks 5-9.
- Test: focused unit tests and stress scenarios for the affected tool group.

- [ ] **Step 1: Pick the single highest p95 contributor**

Expected: one root cause statement, with evidence.

- [ ] **Step 2: Write a failing regression test or benchmark guard**

Expected: test fails on current behavior or benchmark warns on current p95.

- [ ] **Step 3: Implement the smallest safe optimization**

Expected: no unrelated refactor.

- [ ] **Step 4: Re-run before/after benchmark**

Expected: p95/max improves and accuracy checks stay equivalent.

- [ ] **Step 5: Commit that optimization alone**

Use a commit body that includes before/after numbers and the affected tool path.

### Task 12: Repeat for all high-volume tool groups

**Files:**
- Modify as evidence dictates.

- [ ] **Step 1: Repeat Task 11 for `sdl.context`**

Expected: p95 materially improves or the bottleneck is documented as external/environmental.

- [ ] **Step 2: Repeat Task 11 for `sdl.workflow`**

Expected: overhead and child-step timing are separated, then optimized.

- [ ] **Step 3: Repeat Task 11 for `sdl.runtime.execute`**

Expected: SDL overhead is reduced without changing command semantics.

- [ ] **Step 4: Repeat Task 11 for `sdl.file`**

Expected: slow operation variants are optimized without weakening write/source gating.

- [ ] **Step 5: Repeat breadth-first checks for the remaining catalog**

Expected: no unexamined high-volume tool remains above the agreed warning budget.

## Chunk 5: Final Verification and Documentation

### Task 13: Verify performance and accuracy together

**Files:**
- Inspect/modify if needed: `tests/benchmark/context-quality-cases.json`
- Inspect/modify if needed: `docs/benchmark-guardrails.md`

- [ ] **Step 1: Run focused unit tests**

Run the tests changed by the optimization waves.

Expected: all pass.

- [ ] **Step 2: Run relevant stress scenarios**

Run the single-client baseline, concurrent reader scenario, semantic/retrieval scenario, runtime scenario, and file/search edit scenario.

Expected: p95 and max latency improve from the captured baseline.

- [ ] **Step 3: Run quality checks**

Run context quality cases for representative debug/review/implement prompts.

Expected: expected evidence remains present. Faster but less accurate results do not count as success.

- [ ] **Step 4: Run acceptance checks**

Run:

```bash
npm run build
npm run typecheck
npm test
npm run docs:tools:check
```

Expected: all pass or any skipped command is documented with the exact blocker.

### Task 14: Update docs and changelog

**Files:**
- Modify if needed: `docs/feature-deep-dives/observability-dashboard.md`
- Modify if needed: `docs/benchmark-guardrails.md`
- Modify if needed: `CHANGELOG.md`

- [ ] **Step 1: Document new metrics or thresholds**

Expected: users can interpret per-tool phase timing and performance warnings.

- [ ] **Step 2: Document operational guidance**

Include how to collect a latency snapshot, how to run focused stress scenarios, and how to compare cold vs warm calls.

Expected: future regressions can be investigated without rediscovering this workflow.

- [ ] **Step 3: Commit docs with the relevant code change**

Expected: docs and behavior do not drift.

## Completion Criteria

- Every high-volume tool has either a measured optimization or a documented reason it is not currently worth changing.
- `sdl.context`, `sdl.workflow`, `sdl.runtime.execute`, and `sdl.file` have cold/warm p50/p95/p99/max numbers before and after.
- Slow p95 samples can be attributed to phases, not just tool names.
- Accuracy checks pass for `sdl.context` and any retrieval-affecting change.
- Server stability is verified after repeated slow `sdl.context` calls; the endpoint failure observed during planning is either fixed or documented with a reproduction.
- Public observability docs match any metric changes.
- Final commits are small enough to revert independently.
