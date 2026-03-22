---
memoryId: a6bc952cdfe51fc2
type: task_context
title: "Code review round 4 (2026-03-22): 20 fixes across 47 files, theme-based review"
tags: [code-review, security, data-integrity, hardening, round4]
confidence: 0.95
symbols: []
files: [src/graph/overview.ts, src/indexer/ann-index.ts, src/memory/file-sync.ts, src/mcp/tools/symbol.ts, src/mcp/tools/prRisk.ts, src/db/ladybug.ts, src/runtime/artifacts.ts, src/graph/score.ts]
createdAt: 2026-03-22T16:03:03.124Z
deleted: false
---
Fourth exhaustive review using theme-based agents (security, data integrity, API contracts, cascading effects). Found and fixed 20 issues (6 critical, ~12 important, 2 suggestions). All 3125 tests pass.

**Critical fixes:**
1. RegExp injection in overview directory filter — used globToSafeRegex instead of naive regex construction (src/graph/overview.ts)
2. LCG PRNG precision loss in HNSW index — Math.imul for 32-bit integer multiplication (src/indexer/ann-index.ts)
3. Unguarded JSON.parse on SSE event data — 3 occurrences wrapped in try-catch (src/cli/commands/index.ts)
4. Unguarded JSON.parse on database configJson — 3 files wrapped (indexer.ts, watcher.ts, file-patcher.ts)
5. `kinds` parameter silently ignored in symbol search — implemented filtering (src/mcp/tools/symbol.ts)
6. parseYamlArray doesn't handle quoted values with commas — rewrote with proper state-machine parser (src/memory/file-sync.ts)

**Important fixes:**
7. Missing auditHash in PR risk response policyDecision (src/mcp/tools/prRisk.ts)
8. Division by zero in normalizeLinear when max is 0 — guard added in score.ts AND beam-score-worker.ts
9. NaN propagation from parseInt --retries — validation added (src/cli/argParsing.ts)
10. NaN from Number() on HTTP query parameters — 4 occurrences validated (src/cli/transport/http.ts)
11. Unguarded JSON.parse in sync import — 3 occurrences (src/sync/sync.ts)
12. || vs ?? in prRisk rank calculation (src/mcp/tools/prRisk.ts)
13. repoId and taskText missing .min(1) in AgentOrchestrate schema (src/mcp/tools.ts)
14. DatabaseError leaking full filesystem path to MCP clients (src/db/ladybug.ts)
15. ReDoS vulnerability in runtime artifact redaction patterns (src/runtime/artifacts.ts)
16. Last remaining silent .catch(() => {}) in memory update path (src/mcp/tools/memory.ts)
17. Blast radius normalizedFanIn exceeding 1.0 for high fan-in — clamped (src/delta/blastRadius.ts)

**Suggestions fixed:**
18. TOCTOU race in deleteMemoryFile — replaced existsSync+unlinkSync with try-catch (src/memory/file-sync.ts)
19. Temp code files written without restrictive permissions — mode 0o600 (src/mcp/tools/runtime.ts)

**Test fix:**
20. Reindex guidance test updated for path-free error message

**Confirmed clean after 4 rounds:** Zero execSync, zero as any, zero @ts-ignore, zero console.warn in src/, zero bare catch {}, zero unguarded JSON.parse on external input, all imports have .js extensions, all Cypher parameterized, all regex construction uses safe utilities.",
