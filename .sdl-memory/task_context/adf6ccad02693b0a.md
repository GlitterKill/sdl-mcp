---
memoryId: adf6ccad02693b0a
type: task_context
title: "Code review round 7 (2026-03-25): 37 fixes across 26 files, 3 sub-rounds"
tags: [code-review, security, concurrency, data-integrity, round-7]
confidence: 0.95
symbols: []
files: [src/db/ladybug.ts, src/graph/metrics.ts, src/cli/transport/http.ts, src/runtime/executor.ts, src/runtime/artifacts.ts, src/delta/blastRadius.ts, src/code-mode/transforms.ts, src/domain/types.ts, src/mcp/token-usage.ts, src/mcp/tools.ts, src/mcp/tools/slice-wire-format.ts, src/graph/prefetch.ts, src/live-index/overlay-store.ts, src/live-index/reconcile-worker.ts, src/live-index/idle-monitor.ts, src/live-index/checkpoint-service.ts, src/graph/graphSnapshotCache.ts, src/util/concurrency.ts, src/agent/orchestrator.ts, src/agent/executor.ts, src/retrieval/orchestrator.ts, src/services/summary.ts, src/db/ladybug-symbol-embeddings.ts, src/cli/commands/init.ts, src/indexer/watcher.ts, src/server.ts]
createdAt: 2026-03-25T12:02:44.400Z
deleted: false
---
Exhaustive 3-round code review with 5 parallel review agents per round. 37 fixes applied across 26 files (332 insertions, 112 deletions), all verified clean with zero regressions.

CRITICAL fixes (4):
- recycleReadConnection TOCTOU race: recyclingSlots Set guard in ladybug.ts
- closeLadybugDb concurrent read race: synchronous pool snapshot + clear before async close
- normalizeCardDetailLevel unchecked cast: runtime validation against known values
- attachRawContext cache pollution: shallow clone instead of in-place mutation

HIGH fixes (10):
- exec → execFile for git commands in metrics.ts (shell injection via cwd)
- Auth token truncated to 8 chars in http.ts stderr logging
- computeBlastRadius repoId required guard (cross-repo blast radius)
- applyBudgetedSelection recursion depth guard (infinite recursion on bad budget)
- Number() NaN guards in transforms.ts (nondeterministic sort/filter)
- DeltaSymbolChangeSchema → z.discriminatedUnion (schema/type drift)
- Temp workspace leak in executor.ts: try/finally for cleanup
- Artifact handle validation unified: readArtifactContent matches readArtifactManifest
- graphSnapshotCache invalidation clears loadingPromises (stale inflight data)
- OverlayStore setParseResult double version check (concurrent overwrite)

MEDIUM fixes (14):
- spawn shell: false explicit in executor.ts
- loadClientTemplate path traversal guard in init.ts
- Regex flags validation in artifacts.ts (VALID_FLAGS check)
- Cypher property name SAFE_PROP validation in ladybug-symbol-embeddings.ts
- Prefetch queue bounded (MAX_PREFETCH_QUEUE_SIZE=200) with priority comparison
- shutdownPrefetch() exported for shutdown manager
- IdleMonitor per-repo try/catch in scanOnce
- MCPServer.stop() error logging (was bare catch{})
- watcherErrors array bounded (MAX_WATCHER_ERRORS)
- ReconcileWorker per-file try/catch + drain re-trigger in finally
- CompactGraphSliceV2Schema wv required (was optional)
- SliceBuildInput.taskText optional (was required, mismatched schema)
- Unbounded cluster expansion capped to 10 in orchestrator.ts
- Summary seed cache version tracking for stale invalidation

LOW fixes (9):
- ConcurrencyLimiter timeout timers .unref()
- closeLadybugDb drain timeout .unref()
- recyclingSlots.clear() in closeLadybugDb
- clearGraphSnapshots also clears loadingPromises
- chokidar import failure logged
- wv: 2 added to toCompactGraphSliceV2 serializer
- Checkpoint dirty re-check before removeDraft
- Math.random() → crypto.randomUUID() for agent IDs
- entityType validation guard in retrieval orchestrator