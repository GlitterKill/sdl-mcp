---
memoryId: eb324faba4fae2ff
type: task_context
title: "Code review round 5 (2026-03-22): 8 final fixes, codebase clean"
tags: [code-review, round5, clean, final]
confidence: 0.95
symbols: []
files: [src/mcp/tools/symbol.ts, src/benchmark/threshold.ts, src/graph/prefetch-model.ts, src/db/ladybug-metrics.ts, src/db/ladybug-repos.ts, src/db/ladybug-versions.ts]
createdAt: 2026-03-22T17:00:16.077Z
deleted: false
---
Fifth and final review round. Three parallel agents (deep scan, grep-based pattern scan, fix quality verification) found only 3 important + 5 suggestion-level issues. All fixed. Grep scan confirmed: zero empty catches, zero unguarded JSON.parse on external input, zero unsafe RegExp, zero console.* in non-CLI code, zero @ts-ignore, zero unvalidated parseInt/Number(), all setInterval/setTimeout properly managed.

**Important fixes:**
1. `kinds` filter in symbol search bypassed by semantic reranking path — moved filter after both paths converge (src/mcp/tools/symbol.ts)
2. Division by zero in benchmark threshold when baselineValue is 0 (src/benchmark/threshold.ts)
3. Inconsistent zero-guarding: hitRate vs wasteRate in prefetch model (src/graph/prefetch-model.ts)

**Suggestion fixes:**
4. serializeYamlArray now also quotes strings containing backslashes (src/memory/file-sync.ts)
5. Five remaining Cypher LIMIT interpolations parameterized (ladybug-metrics.ts, ladybug-repos.ts, ladybug-versions.ts, buildGraph.ts)
6. ts/mapping.ts JSON.parse on configJson now wrapped in try-catch
7. watcher.ts staleTimer setInterval now has .unref()
8. Benchmark JSON.parse calls wrapped in try-catch (edgeAccuracy.ts, threshold.ts)

**Cumulative totals across rounds 3-5: 59 fixes across 55 files. All 3125 tests pass.**