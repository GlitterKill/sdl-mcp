# Active Dispatch Age Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, oldest-first age and cancellation diagnostics to the existing tool-dispatch queue-timeout log without changing dispatch behavior or public MCP/error contracts.

**Architecture:** Keep one private per-admitted-invocation registry beside the existing active-label count map in `src/mcp/dispatch-limiter.ts`. Register after limiter admission, remove in the existing `finally`, and derive a single capped snapshot only when a queue timeout is logged. Expose one underscore-prefixed test seam for cleanup assertions; do not add timers, schemas, or configuration.

**Tech Stack:** TypeScript, Node.js `node:test`, existing `ConcurrencyLimiter` and logger.

---

## Chunk 1: Focused TDD implementation

### Task 1: Write the failing timeout-diagnostic test

**Files:**
- Modify: `tests/unit/dispatch-limiter.test.ts`

- [ ] Import `_getActiveDispatchDiagnosticsForTesting` from the compiled dispatch limiter and `logger` from the compiled logger.
- [ ] Add one focused test named `logs bounded oldest-first active dispatch diagnostics on queue timeout`.
- [ ] Temporarily replace `Date.now` with a controlled clock, restoring it in `finally`. Configure concurrency to exactly 34 and sequentially admit 34 blocked `runToolDispatch` calls, awaiting each admission before advancing the clock. Give the first three calls no signal, a live signal, and an aborted-after-admission signal.
- [ ] After all 34 admission barriers resolve, abort the third signal and start a 35th call with a short timeout so it must queue.
- [ ] Temporarily capture `logger.warn`. Assert the rejected value remains a `ToolDispatchQueueTimeoutError` with the exact existing `name`, `message`, `code`, `classification`, `retryable`, `suggestedRetryDelayMs`, and `details`, including the unchanged active-label metadata.
- [ ] Assert only the warning metadata gains diagnostics: 32 oldest-first entries with exact controlled `ageMs` values and `cancellationState` values `none`, `active`, and `aborted`, plus `activeDispatchesOmitted: 2`.
- [ ] Release and await every admitted call, then assert `_getActiveDispatchDiagnosticsForTesting()` returns no entries.
- [ ] Extend `clears active dispatch labels on reset` to assert the diagnostic registry is also empty after reset.
- [ ] Build the unchanged production source, then run the focused test and record the expected RED failure because the testing export/diagnostics do not exist:

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/dispatch-limiter.test.ts
```

### Task 2: Implement the minimum private registry and timeout snapshot

**Files:**
- Modify: `src/mcp/dispatch-limiter.ts`

- [ ] Add a private active-dispatch record containing only `label`, `startedAtMs`, and optional `AbortSignal`; key records by a process-monotonic private invocation id.
- [ ] Add a fixed `32` snapshot limit. Preserve admission order with `Map` insertion order, compute non-negative ages at snapshot time, and map signals to `none | active | aborted`.
- [ ] Export `_getActiveDispatchDiagnosticsForTesting(nowMs = Date.now())` returning the same bounded entries and omitted count used by logging.
- [ ] In `runToolDispatch`, register immediately after admission and remove the exact record in the same `finally` that decrements the active-label count.
- [ ] On `ConcurrencyQueueTimeoutError`, add only `activeDispatches` and `activeDispatchesOmitted` to the existing `logger.warn` metadata. Leave `ToolDispatchStats`, `ToolDispatchQueueTimeoutError`, schemas, and dispatch/cancellation behavior unchanged.
- [ ] Clear the diagnostic registry in `resetToolDispatchLimiter`, but never reset/reuse the invocation id because pre-reset work can finish later.
- [ ] Add concise comments at registration/snapshot points explaining that the registry is diagnostic-only and sampled only on timeout.
- [ ] Rebuild and rerun the focused test; verify GREEN:

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/dispatch-limiter.test.ts
```

### Task 3: Verify scope and repository quality gates

**Files:**
- Verify: `src/mcp/dispatch-limiter.ts`
- Verify: `tests/unit/dispatch-limiter.test.ts`
- Reference: `devdocs/superpowers/specs/2026-09-01-active-dispatch-age-diagnostics-design.md`

- [ ] Use the repository `test-scope` skill to select any additional affected tests and run only those it identifies.
- [ ] Run the static checks:

```powershell
npm run typecheck
npm run lint
```

- [ ] Inspect the final diff for unrelated changes, generated artifacts, public contract changes, and accidental index-refresh calls.
- [ ] Request independent specification and code-quality reviews against the design spec and resolve any valid findings.
- [ ] Commit the implementation locally with a narrow message. Do not push and do not refresh the index.
