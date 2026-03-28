# Orchestrator Context Modes

[Back to README](../../README.md) | [Agent Orchestration Overview](./agent-orchestration.md)

---

## The Problem

LLMs using SDL-MCP tools need code context. The naive approach — manually chaining `symbol.search` -> `symbol.getCard` -> `code.getSkeleton` -> `code.getHotPath` — works but has two costs:

1. **Token overhead**: Each tool call returns its own JSON envelope (schema metadata, etags, version info). Four calls = four envelopes.
2. **Latency**: Sequential calls mean sequential round-trips. Each call waits for the previous to resolve.
3. **Planning burden**: The LLM must decide which tools to call, in what order, with what parameters. This decision-making itself consumes tokens.

`sdl.agent.orchestrate` solves all three by accepting a natural-language task description and returning exactly the context needed — in a single call, with a single envelope.

---

## Context Modes

The `contextMode` option (`"precise"` or `"broad"`) controls how much context the orchestrator returns.

```
                        ┌─────────────────────────────────────────┐
  "What does X do?"  ──>│  contextMode: "precise"                 │
                        │                                         │
                        │  1 symbol scored & selected              │
                        │  1 card + 1 skeleton (explain)          │
                        │  Response envelope stripped              │
                        │  ~1,200 bytes                           │
                        └─────────────────────────────────────────┘

                        ┌─────────────────────────────────────────┐
  "Understand the    ──>│  contextMode: "broad" (default)         │
   auth pipeline"       │                                         │
                        │  3-7 symbols scored & selected          │
                        │  Multiple cards + skeletons + hotpaths  │
                        │  Full response with answer & diagnostics│
                        │  ~8,000 bytes                           │
                        └─────────────────────────────────────────┘
```

### Precise Mode

Designed for targeted lookups where the LLM knows what it wants. Returns the minimum context needed to answer the question — typically 1 card + 1 skeleton or 1 card + 1 hotpath.

**Token efficiency**: 50-70% smaller responses than manual `sdl.chain` for the same query. Achieved through:

- **Aggressive symbol selection**: Only the single highest-scoring symbol is processed per rung
- **Minimal rung plans**: `explain` = card + skeleton, `debug` = card + hotPath, `review` = card only
- **No file-level skeletons**: Symbol-level skeletons only
- **Stripped envelope**: No `actionsTaken`, `summary`, `answer`, `nextBestAction`, or `retrievalEvidence`

**When to use**: "What does X do?", "Check Y for NaN handling", "Show me the signature of Z"

### Broad Mode (default)

Designed for investigation and exploration where the LLM needs surrounding context to understand relationships.

**Context richness**: Multiple related symbols, file-level skeletons for structural overview, full diagnostics for debugging the orchestrator itself.

- **Adaptive symbol selection**: Relevance threshold at 40% of top score, up to 20 cards
- **Full rung plans**: All rungs appropriate for the task type
- **File-level skeletons**: 1 file skeleton when symbol skeletons exist, full count as fallback
- **Full envelope**: Complete response with synthesized answer, action trace, and next-best-action guidance

**When to use**: "Understand the auth pipeline", "How does error handling work across modules?", "Investigate the performance bottleneck"

---

## Adaptive Symbol Relevance Ranking

When `focusPaths` are provided, the orchestrator resolves all symbols in those files (up to 50 per file). Without ranking, the first N symbols in database order would be processed — producing irrelevant results like utility helpers instead of the target function.

The `selectTopSymbols` algorithm scores each symbol against the task text:

| Signal | Score | Example |
|:-------|:-----:|:--------|
| Exact name appears in task text | +10 | Task: "check normalizeEdgeConfidence" -> symbol `normalizeEdgeConfidence` scores +10 |
| Name matches an extracted identifier | +8 | `extractIdentifiersFromTask` finds `normalizeEdgeConfidence` via camelCase regex |
| Partial name overlap (3+ chars) | +3 | Symbol `applyEdgeConfidenceWeight` contains "confidence" from task identifiers |
| Summary contains task keyword | +2 | Symbol summary mentions "edge" or "confidence" |
| Exported symbol | +1 | Tiebreaker: entry points rank above internal helpers |

**Identifier extraction** from task text uses multiple passes:
1. camelCase patterns: `handleRequest`, `normalizeEdgeConfidence`
2. PascalCase patterns: `IndexError`, `BeamSearchResult`
3. Single-word PascalCase (6+ chars): `Executor`, `Planner`
4. snake_case patterns: `max_retries`, `error_handler`
5. Existing evidence names from prior rungs
6. Fallback: any 3+ char word not in the stop-word list

**Adaptive threshold**:
- Precise mode: `max(5, topScore * 0.6)` — only symbols scoring well above noise
- Broad mode: `max(3, topScore * 0.4)` — includes more surrounding context

**Short-name filter**: Symbols with 1-2 character names (`i`, `r`, `x`) are excluded from exact-match and partial-match scoring to prevent false positives from substring matching (e.g., "i" appearing inside "handleFileRead").

### Ranking Example

Task: "Investigate NaN handling in normalizeEdgeConfidence"

| Symbol | Score | Why | Selected? |
|:-------|:-----:|:----|:---------:|
| `normalizeEdgeConfidence` | 24 | exact(10) + identifier(8) + partial(3) + summary(2) + exported(1) | Yes |
| `applyEdgeConfidenceWeight` | 6 | partial("confidence", 3) + summary(2) + exported(1) | Broad only |
| `DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN` | 5 | partial("confidence", 3) + summary(2) | Broad only |
| `normalizeEdgeType` | 4 | partial("edge", 3) + exported(1) | No |
| `toLegacySymbolRow` | 1 | exported(1) | No |

Precise threshold: `max(5, 24 * 0.6)` = 14.4 -> only `normalizeEdgeConfidence` selected.
Broad threshold: `max(3, 24 * 0.4)` = 9.6 -> only `normalizeEdgeConfidence` selected (next highest is 6).

---

## Rung Planning by Mode

The planner selects rungs based on task type and context mode:

| Task Type | Precise | Broad |
|:----------|:--------|:------|
| `debug` | card -> hotPath | card -> skeleton -> hotPath -> raw* |
| `explain` | card -> skeleton | card -> skeleton |
| `review` | card | card -> skeleton |
| `implement` | card -> skeleton | card -> skeleton -> hotPath |

*`raw` only included when `requireDiagnostics: true`.

### Why Precise Plans Differ

- **Debug precise** skips skeleton because the hotPath already shows the relevant code with matched identifiers. A skeleton would add ~200 tokens of structural overview that doesn't help answer "is there a NaN guard?"
- **Review precise** uses card only because a review of a specific symbol just needs its signature, dependencies, and metrics. The skeleton is useful in broad mode for understanding surrounding structure.
- **Explain precise** keeps skeleton because "what does X do?" questions benefit from seeing control flow. Card alone shows the signature but not the logic.
- **Implement precise** keeps skeleton because writing new code requires understanding the structural pattern to follow.

---

## Response Envelope

### Broad Mode Response

All fields populated:

```json
{
  "taskId": "task-...",
  "taskType": "debug",
  "path": { "rungs": ["card", "skeleton", "hotPath"], "estimatedTokens": 750, "reasoning": "..." },
  "actionsTaken": [{ "type": "getCard", "status": "completed", ... }, ...],
  "finalEvidence": [{ "type": "symbolCard", "reference": "...", "summary": "..." }, ...],
  "summary": "Task completed. 3 actions, 7 evidence items.",
  "answer": "# Debug Results\n\n## Symbols Found...",
  "success": true,
  "metrics": { "totalTokens": 750, "totalDurationMs": 280, ... },
  "nextBestAction": null,
  "retrievalEvidence": { "symptomType": "taskText" }
}
```

### Precise Mode Response

Envelope stripped — only context-bearing fields:

```json
{
  "taskId": "task-...",
  "taskType": "debug",
  "path": { "rungs": ["card", "hotPath"], "estimatedTokens": 550, "reasoning": "Precise debug: card + hotPath" },
  "actionsTaken": [],
  "finalEvidence": [
    { "type": "symbolCard", "reference": "symbol:...", "summary": "function normalizeEdgeConfidence | ..." },
    { "type": "hotPath", "reference": "hotpath:...", "summary": "Hot path (1 match): if (typeof confidence !== \"number\" || Number.isNaN(confidence)) return 1; ..." }
  ],
  "summary": "",
  "success": true,
  "metrics": { "totalTokens": 550, "totalDurationMs": 167, ... }
}
```

### What Gets Stripped and Why

| Field | Broad | Precise | Reason for Stripping |
|:------|:-----:|:-------:|:---------------------|
| `actionsTaken` | Full array | `[]` | Diagnostics — LLM doesn't need execution trace for targeted lookup |
| `summary` | Generated text | `""` | Redundant — restates what's in `finalEvidence` |
| `answer` | Markdown summary | Omitted | Redundant — with 1 card, the evidence IS the answer |
| `nextBestAction` | Guidance string | Omitted | Not needed — LLM already knows what it wants |
| `retrievalEvidence` | `{ symptomType }` | Omitted | Always `"taskText"` in orchestrator — zero information |

---

## Token Savings Meter

The orchestrator integrates with SDL-MCP's token savings meter. The meter compares the actual response size (SDL tokens) against what reading the raw source files would have cost (raw equivalent).

**Raw equivalent estimation**:
- When `focusPaths` are provided: actual file byte sizes from the database (accurate)
- Fallback: `metrics.totalTokens * 3` (rough planner-based estimate)

The meter displays in MCP protocol responses (Claude Code, Codex, etc.):

```
📊 380 / 12.4k tokens █████████░ 97%
```

This means the orchestrator returned 380 tokens of context instead of the ~12,400 tokens the LLM would have consumed reading the raw files.

---

## Benchmarks

Measured against manual `sdl.chain` (4-step sequential: search -> card -> skeleton -> hotPath) on the SDL-MCP codebase (85K lines, 895 files):

### Test 1: Debug — "Check NaN handling in normalizeEdgeConfidence"

| Metric | sdl.chain | orchestrate precise | orchestrate broad |
|:-------|:---------|:-------------------|:-----------------|
| Response bytes | 4,347 | **1,191** | 8,312 |
| Evidence | 1c 0s 1h | 1c 0s 1h | 2c 3s 2h |
| Wall clock | 7,894 ms | ~2,000 ms | ~2,100 ms |
| Top result | normalizeEdgeConfidence | normalizeEdgeConfidence | normalizeEdgeConfidence |

### Test 2: Explain — "Understand how buildBeamSearchResult works"

| Metric | sdl.chain | orchestrate precise | orchestrate broad |
|:-------|:---------|:-------------------|:-----------------|
| Response bytes | 2,244 | **1,208** | 8,060 |
| Evidence | 1c 1s 0h | 1c 1s 0h | 3c 4s 0h |
| Wall clock | 5,927 ms | ~2,000 ms | ~2,100 ms |
| Top result | buildBeamSearchResult | buildBeamSearchResult | buildBeamSearchResult |

### Test 3: Simple — "What does handleFileRead do?"

| Metric | sdl.chain | orchestrate precise | orchestrate broad |
|:-------|:---------|:-------------------|:-----------------|
| Response bytes | 2,556 | **1,139** | 4,259 |
| Evidence | 1c 0s 0h | 1c 0s 0h | 1c 2s 0h |
| Wall clock | 4,002 ms | ~2,000 ms | ~2,000 ms |
| Top result | handleFileRead | handleFileRead | handleFileRead |

### Key Takeaways

- **Precise mode beats chain on every metric**: 46-73% fewer bytes, 2-4x faster wall clock, same evidence quality
- **Broad mode provides richer context**: 2-7x more evidence items for investigation tasks
- **Both modes find the right target**: Adaptive relevance ranking ensures the target symbol is always first regardless of how many symbols exist in the focus files

---

## Decision Guide

```
  Do you know the specific symbol or function name?
     │
     ├── YES ──> contextMode: "precise"
     │           taskType: "explain" (understand it) or "debug" (find a bug in it)
     │
     └── NO ───> contextMode: "broad" (default)
                 taskType: "explain" (understand a module) or "debug" (trace a flow)
                 Provide focusPaths to the relevant directory/files
```

**Rule of thumb**: If your task text mentions a specific function or class name, use `"precise"`. If it describes a behavior or flow, use `"broad"`.

---

## Architecture

```
  sdl.agent.orchestrate request
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │  Orchestrator (src/agent/orchestrator.ts)        │
  │                                                  │
  │  1. Validate task                                │
  │  2. Plan rungs (Planner)                         │
  │  3. Select context (focusPaths -> symbols)       │
  │  4. Entity search fallback (if no explicit ctx)  │
  │  5. Feedback-aware boosting                      │
  │  6. Cluster expansion                            │
  │  7. Execute rungs (Executor)                     │
  │  8. Strip envelope (if precise)                  │
  └─────────────────────────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │  Planner (src/agent/planner.ts)                  │
  │                                                  │
  │  taskType + contextMode -> rung selection         │
  │  Budget enforcement (trim from end)              │
  └─────────────────────────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │  Executor (src/agent/executor.ts)                │
  │                                                  │
  │  For each rung:                                  │
  │  1. resolveContextToSymbols (file -> symbolIds)  │
  │  2. selectTopSymbols (rank by task relevance)    │
  │  3. Execute rung (getCard/getSkeleton/getHotPath)│
  │  4. Capture evidence                             │
  │                                                  │
  │  contextMode controls:                           │
  │  - Symbol count per rung (1 vs adaptive max)     │
  │  - Score threshold (60% vs 40% of top)           │
  │  - File skeleton generation (skip vs include)    │
  └─────────────────────────────────────────────────┘
```

### Key Files

| File | Responsibility |
|:-----|:--------------|
| `src/agent/orchestrator.ts` | Top-level orchestration, context seeding, envelope stripping |
| `src/agent/planner.ts` | Rung selection per task type + context mode, budget trimming |
| `src/agent/executor.ts` | Rung execution, `selectTopSymbols`, `extractIdentifiersFromTask` |
| `src/agent/evidence.ts` | Evidence capture and deduplication |
| `src/agent/types.ts` | `AgentTask`, `TaskOptions` (includes `contextMode`), `OrchestrationResult` |
| `src/mcp/tools/agent.ts` | MCP handler, token meter attachment |
| `src/mcp/tools.ts` | Zod schema (`AgentOrchestrateRequestSchema`) |

---

## Related

- [Agent Orchestration Overview](./agent-orchestration.md) — Feedback loop, context summaries, predictive prefetch
- [Token Savings Meter](./token-savings-meter.md) — How savings are calculated and displayed
- [MCP Tools Reference](../mcp-tools-reference.md#sdlagentorchestrate) — Parameter reference
- [Agent Workflows](../agent-workflows.md) — Autopilot guidance for LLM consumers

[Back to README](../../README.md)
