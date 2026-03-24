---
memoryId: d10e42ef4dbee2bd
type: task_context
title: "Code review round 6 (2026-03-24): 49 findings, 36 files modified across 5 categories"
tags: [code-review, round6, security, performance, resilience]
confidence: 0.95
symbols: []
files: [src/graph/metrics.ts, src/main.ts, src/cli/commands/serve.ts, src/mcp/tools.ts, src/mcp/tools/slice-wire-format.ts, src/db/ladybug-memory.ts, src/db/ladybug-edges.ts, src/util/logger.ts]
createdAt: 2026-03-24T11:51:05.165Z
deleted: false
---
Sixth review round using 5 parallel SDL-MCP exploration agents (security, error handling, database, API contracts, concurrency/performance). Found 49 issues (1 high, 1 medium-high, 12 medium, 7 low-medium, 24 low, 4 informational). All addressed in 36 files.

**High/Medium-High fixes:**
1. `collectTestRefs` in metrics.ts: synchronous `readFileSync` in loop replaced with async `readFile` in 10-file chunks (biggest perf win)
2. `uncaughtException` handlers in main.ts + serve.ts: now call `process.exit(1)` after logging sanitized message to stderr (full stack to log file only)

**Key medium fixes:**
3. Memories silently dropped in compact wire format — added `memories` field to all 3 compact schemas + serializer
4. Prototype pollution via `Object.assign(result, stdinArgs)` — destructure `__proto__`/`constructor`/`prototype` before assign
5. Missing transactions in `deleteMemoryEdges` and `deleteEdgesByFileId`
6. Timer leaks in Promise.race patterns (blastRadius.ts, ladybug.ts)
7. BFS queue unbounded in `batchComputeCanonicalTests` — capped at 50K
8. Logger switched from `appendFileSync` to buffered `WriteStream`

**Verification:** Build output identical (171 error lines before/after — all pre-existing tree-sitter/OpenTelemetry type issues). 305 JS files emitted. Tests have pre-existing failure from OpenTelemetry `resourceFromAttributes` export mismatch unrelated to changes.

**Cumulative totals across rounds 3-6: ~108 fixes across ~90 files.**