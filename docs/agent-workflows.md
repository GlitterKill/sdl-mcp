# Agent Workflows

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows (this page)](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)

</details>
</div>

This page defines practical workflows for coding agents using SDL-MCP.

## Complete Tool Reference

SDL-MCP exposes 30 MCP tools in flat mode (plus 3 code-mode tools and 4 gateway tools) across 13 categories. Every workflow on this page uses tools from this table.

| Category | Tool | Purpose |
|:---------|:-----|:--------|
| **Repository** | `sdl.repo.register` | Register a new repository for indexing |
| | `sdl.repo.status` | Get repo status, health metrics, watcher state, prefetch stats |
| | `sdl.index.refresh` | Trigger full or incremental re-indexing |
| | `sdl.repo.overview` | Token-efficient codebase overview (stats, directories, hotspots, clusters, processes) |
| **Live Buffers** | `sdl.buffer.push` | Push editor buffer content with cursor/selection tracking for draft-aware indexing |
| | `sdl.buffer.checkpoint` | Trigger a checkpoint to persist draft changes into the symbol overlay |
| | `sdl.buffer.status` | Check live buffer state (pending, dirty, queue depth) |
| **Symbols** | `sdl.symbol.search` | Search symbols by name or summary; supports semantic reranking via `semantic: true` |
| | `sdl.symbol.getCard` | Get a single symbol card with ETag caching and optional `minCallConfidence` filtering |
| | `sdl.symbol.getCards` | Batch fetch up to 100 cards in one round trip; supports `knownEtags` for delta fetching |
| **Slices** | `sdl.slice.build` | Build graph slice from entry symbols, task text, stack traces, or edited files |
| | `sdl.slice.refresh` | Refresh an existing slice handle; returns incremental delta only |
| | `sdl.slice.spillover.get` | Paginated fetch for overflow symbols beyond budget |
| **Code Access** | `sdl.code.getSkeleton` | Deterministic skeleton IR (signatures + control flow, elided bodies) |
| | `sdl.code.getHotPath` | Hot-path excerpt: only lines matching specified identifiers |
| | `sdl.code.needWindow` | Full raw code window (gated — requires proof-of-need justification); accepts `sliceContext` |
| **Deltas** | `sdl.delta.get` | Delta pack between two versions with blast radius and fan-in trends |
| **Policy** | `sdl.policy.get` | Read current policy settings |
| | `sdl.policy.set` | Update policy (merge patch) |
| **Risk** | `sdl.pr.risk.analyze` | Analyze PR risk, blast radius, and recommend test targets |
| **Agent** | `sdl.agent.orchestrate` | Autonomous task execution with budget-controlled rung path planning |
| | `sdl.agent.feedback` | Record which symbols were useful/missing after a task; supports `taskTags` |
| | `sdl.agent.feedback.query` | Query feedback records and aggregated statistics |
| **Context** | `sdl.context.summary` | Generate token-bounded summary for non-MCP contexts (clipboard, markdown, JSON) |
| **Runtime** | `sdl.runtime.execute` | Sandboxed subprocess execution (`node`, `python`, `shell`) with structured output |
| **Memory** | `sdl.memory.store` | Store or update a development memory with symbol/file links |
| | `sdl.memory.query` | Search memories by text, type, tags, or linked symbols; `staleOnly` filter |
| | `sdl.memory.remove` | Soft-delete a memory from graph and optionally from disk |
| | `sdl.memory.surface` | Auto-surface relevant memories ranked by confidence, recency, and symbol overlap |
| **Usage** | `sdl.usage.stats` | Get cumulative token usage statistics and savings metrics |
| **Code Mode** *(optional)* | `sdl.action.search` | Discover the most relevant SDL actions with optional schema/example metadata |
| | `sdl.manual` | Return a compact filtered API reference for a queried or explicit action subset |
| | `sdl.chain` | Execute up to 50 actions in a single round trip with `$N` result piping, transforms, and optional traces |

---

## Paste-Ready AGENTS.md Block

Copy this block into `AGENTS.md` for token-efficient SDL-MCP usage on the current codebase/tooling. Replace `[repoid]` with your repo's ID.

```md
## SDL-MCP Token-Efficient Protocol (v0.9)

- Repository ID: `[repoid]`
- MCP Server: `sdl-mcp`

### 0) Establish state before deep context

1. Call `sdl.repo.status` first.
2. If local code changed and indexing is stale, run `sdl.index.refresh` with `mode: "incremental"`.
3. Call `sdl.policy.get` and honor returned caps. Current effective policy is:
   - `maxWindowLines: 180`
   - `maxWindowTokens: 1400`
   - `requireIdentifiers: true`

### 1) The Iris Gate Ladder (Token-Efficient Context Escalation)

Use this order unless task constraints force escalation:

1. `sdl.repo.overview` (start with `level: "stats"`; use `directories`/`full` only when needed).
2. `sdl.symbol.search` with a tight `limit` (`5-20` to start; default is `50`, max is `1000`).
   - Add `semantic: true` to enable embedding-based reranking for fuzzy or conceptual queries.
3. `sdl.symbol.getCard` for single lookups; send `ifNoneMatch` to get `notModified` responses.
   - Use `sdl.symbol.getCards` (batch, up to 100 IDs) when fetching multiple symbols — one round trip instead of many.
   - Pass `knownEtags` to `getCards` for delta fetching (unchanged cards return as refs, not full payloads).
   - Use `minCallConfidence` to filter low-confidence call edges from card responses.
4. `sdl.slice.build` with explicit budget and compact output:
   - Keep `wireFormat: "compact"` (default) and `wireFormatVersion: 2` (default).
   - Use `wireFormatVersion: 3` for grouped edge encoding when slices exceed 50 cards.
   - Set budget early, for example: `{ "maxCards": 30, "maxEstimatedTokens": 4000 }`.
   - Use `minConfidence` to drop low-trust edges (default `0.5`; adaptive thresholds can tighten to `0.8` and `0.95` as token usage approaches budget).
   - Use `minCallConfidence` to filter low-confidence call edges within slice cards.
   - Always provide `entrySymbols` when available.
   - Provide `knownCardEtags` to avoid resending unchanged cards (`cardRefs` are returned instead).
   - `cardDetail` levels: `"minimal"` | `"signature"` | `"deps"` | `"compact"` | `"full"`. Leave unset for mixed compact/full behavior. Use `"full"` only when you truly need full cards for all slice symbols. Use `adaptiveDetail: true` to let SDL-MCP choose detail levels per-card based on relevance.
   - **Auto-discovery mode**: pass `taskText` (and optionally `stackTrace`, `failingTestPath`, or `editedFiles`) instead of `entrySymbols` to let SDL-MCP find relevant symbols automatically.
5. `sdl.slice.refresh` if you already have a `sliceHandle`; prefer refresh over rebuilding.
6. `sdl.slice.spillover.get` only when necessary; keep `pageSize` small (default `20`, max `100`).
7. `sdl.code.getSkeleton` before `hotPath` or raw windows. In file mode, prefer `exportedOnly: true` when possible.
8. `sdl.code.getHotPath` with focused identifiers (`1-3` identifiers, low `contextLines`, default `3`).
9. `sdl.code.needWindow` last. Keep requests tight:
   - `expectedLines <= 180`
   - `maxTokens <= 1400`
   - Non-empty `identifiersToFind` (required by policy)
   - Pass `sliceContext` to give the gating engine task context (e.g., `{ taskText, stackTrace, failingTestPath, editedFiles, entrySymbols }`) — this improves approval likelihood for justified requests.

### 2) Task-specific workflows

- **Debug**: `search -> card -> slice.build -> hotPath -> needWindow (only if still ambiguous)`.
- **Debug (auto-discovery)**: `slice.build` with `taskText` describing the bug + `stackTrace` and/or `failingTestPath` if available → SDL-MCP finds symbols automatically. Pass the same context via `sliceContext` to `code.needWindow` if raw code is needed.
- **Feature implementation**: `repo.overview -> search -> card -> slice.build`. Use `editedFiles` in `slice.build` to include symbols from files you're actively modifying.
- **PR review**: `delta.get -> pr.risk.analyze -> card/hotPath for high-risk symbols`.
- **Live editing**: `buffer.push` as files change (with cursor/selection tracking) → `buffer.checkpoint` to persist → search/card/slice now reflect draft state.
- **Context export**: `context.summary` with `format: "clipboard"` to produce a summary for non-MCP tools.
- **Test execution**: `runtime.execute` with the narrowest useful runtime (`node`, `python`, or `shell`) to run tests and capture structured output.
- **Multi-step chain** *(Code Mode)*: `sdl.action.search` -> focused `sdl.manual` -> `sdl.chain` for multi-step context or runtime workflows in one round trip.

### 3) Token controls by tool

- `sdl.repo.overview`:
  - `level: "stats"` is cheapest.
  - `level: "full"` auto-enables hotspots unless overridden.
  - Use `directories`, `maxDirectories`, and `maxExportsPerDirectory` to bound payload.
- `sdl.symbol.search`:
  - Keep `limit` low (5–20) to start. Increase only if no results match.
  - `semantic: true` adds ~50ms latency but dramatically improves relevance for conceptual queries.
- `sdl.symbol.getCard` / `sdl.symbol.getCards`:
  - Use `minCallConfidence` to filter out low-confidence call edges, reducing card size.
  - Use `knownEtags` (batch) or `ifNoneMatch` (single) to skip unchanged cards entirely.
- `sdl.slice.build`:
  - Keep `minConfidence` near `0.5` for recall-oriented work and raise it for precision-focused runs.
  - Use `minCallConfidence` to additionally filter low-confidence call edges in returned cards.
  - Slice cards filter `deps.calls`/`deps.imports` to only in-slice symbols and include per-dependency confidence scores.
  - Use `wireFormatVersion: 3` for grouped edge encoding when slices exceed 50 cards.
  - Use `adaptiveDetail: true` to let SDL-MCP vary card detail levels by relevance score.
  - `cardDetail` options: `"minimal"` (cheapest) → `"signature"` → `"deps"` → `"compact"` → `"full"` (most expensive).
- `sdl.code.needWindow`:
  - Pass `sliceContext` so the gating engine can approve requests without break-glass when task context justifies them.
  - Supported `granularity` values: `"symbol"` (default), `"block"`, `"fileWindow"`.
- `sdl.delta.get`:
  - Pass `budget` for large version diffs to constrain blast-radius work.
- `sdl.pr.risk.analyze`:
  - Raise `riskThreshold` (for example `80`) to focus on highest-risk changes.
- `sdl.context.summary`:
  - Set `budget` to cap output tokens. Use `scope: "task"` for multi-symbol summaries, `scope: "symbol"` for single-symbol.
- `sdl.runtime.execute`:
  - Set `timeoutMs` and `maxResponseLines` to bound output. Use `queryTerms` to extract relevant excerpts from long output.
- `sdl.chain` *(Code Mode)*:
  - Set `budget.maxTotalTokens` and `budget.maxSteps` to bound chain execution.
  - Use `onError: "continue"` (default) to let the chain proceed past failures, or `"stop"` to halt on first error.

### 4) Live buffer workflow

When working in an editor with live buffer support:

1. Editor pushes `sdl.buffer.push` on each `change`/`save`/`close` event with the file's current content and a monotonically increasing `version` number.
2. Call `sdl.buffer.status` to check how many buffers are pending/dirty.
3. Call `sdl.buffer.checkpoint` to persist draft symbols into the overlay.
4. All subsequent `search`, `getCard`, `slice.build`, and `getSkeleton` calls now reflect the draft state — no re-index needed.

Stale buffer pushes (version ≤ current) are rejected automatically.

### 5) Autopilot (`sdl.agent.orchestrate`) guidance

- Always provide a budget (`maxTokens`, `maxActions`, optionally `maxDurationMs`).
- Always scope with `focusSymbols` and/or `focusPaths`.
- Avoid `requireDiagnostics` unless needed; it can add a raw rung.
- Task types: `"debug"`, `"review"`, `"implement"`, `"explain"`.
- Planner token estimates are approximately:
  - `card`: `50`
  - `skeleton`: `200`
  - `hotPath`: `500`
  - `raw`: `2000`
- When over budget, planner trims rungs from the end while keeping at least one rung.

### 6) Runtime execution (`sdl.runtime.execute`)

Run commands in a repo-scoped subprocess. Requires `runtime.enabled: true` in config.

```json
{
  "repoId": "[repoid]",
  "runtime": "node",
  "args": ["--test", "tests/auth.test.ts"],
  "timeoutMs": 30000,
  "queryTerms": ["FAIL", "Error"],
  "maxResponseLines": 100
}
```

- **Runtimes**: currently supported runtimes are `"node"`, `"python"`, and `"shell"`.
- Use `code` to run inline code or `args` to invoke a file.
- `queryTerms` extracts only matching lines from output (like a built-in grep).
- `persistOutput: true` saves full output to an artifact handle for later retrieval.

### 7) Context export (`sdl.context.summary`)

Use `sdl.context.summary` to generate token-bounded summaries for non-MCP contexts (clipboard, PR descriptions, tickets).

- Pass `query` (required), `budget` (token cap), `format` (`"markdown"` | `"json"` | `"clipboard"`), and `scope` (`"symbol"` | `"file"` | `"task"`).
- Use `scope: "task"` for multi-symbol summaries; `scope: "symbol"` for single-symbol.
- Use `format: "clipboard"` for paste-ready output.

### 8) Code Mode (`sdl.chain`)

When `codeMode.enabled: true` is set in config, three additional tools are available:

- `sdl.action.search` — returns the most relevant SDL actions for a query, optionally with schema and example metadata.
- `sdl.manual` — returns a compact filtered API reference for all or part of the action surface.
- `sdl.chain` — executes up to 50 actions in a single round trip with `$N` result piping, internal data transforms, and optional traces.

Chain guidance:
- Start with `sdl.action.search` when the right action is unclear.
- Use `sdl.manual(query|actions)` to avoid loading the full manual when a subset is enough.
- Each step has `fn` (action name) and `args`. Use `$N.path.to.field` to reference step N's result (0-based).
- Set `budget`: `{ maxTotalTokens, maxSteps, maxDurationMs }`.
- `onError`: `"continue"` (default, skip failed steps) or `"stop"` (halt on first error).
- The chain enforces the same context-ladder escalation rules as individual tools.
- Cross-step ETag caching is automatic — no need to pass ETags manually between steps.
- Use chains for multi-step lookups, data shaping, and runtime execution in high-latency environments or CI pipelines. Do not use for single actions.

### 9) Feedback loop (`sdl.agent.feedback`)

After completing a task, call `sdl.agent.feedback` with:
- `versionId` (from `sdl.repo.status`), `sliceHandle` (from `sdl.slice.build`).
- `usefulSymbols` (required, min 1), `missingSymbols` (optional).
- `taskType` (`"debug"` | `"review"` | `"implement"` | `"explain"`), `taskText`, `taskTags`.

This trains the slice ranker and improves future context quality.

Use `sdl.agent.feedback.query` with `limit` and `since` (ISO timestamp) to review aggregated stats on which symbols are most frequently useful/missing.

### 10) Policy management (`sdl.policy.get` / `sdl.policy.set`)

1. Call `sdl.policy.get` to read current gating thresholds.
2. Call `sdl.policy.set` with `policyPatch` (merge patch — only supplied fields change):
   - `maxWindowLines` / `maxWindowTokens` — raise for large functions.
   - `allowBreakGlass: false` — enforce strict proof-of-need gating.
   - `requireIdentifiers: false` — allow unscoped code window requests (not recommended).

### 11) Development memories

Store cross-session knowledge that auto-surfaces in future slice builds:

- **Store**: `sdl.memory.store` with `type` (`"decision"` | `"bugfix"` | `"task_context"`), `title`, `content`, optional `symbolIds`, `fileRelPaths`, `tags`, `confidence`.
- **Query**: `sdl.memory.query` with `query` (text search), `types`, `tags`, `symbolIds`, `staleOnly`, `limit`, `sortBy` (`"recency"` | `"confidence"`).
- **Surface**: `sdl.memory.surface` with `symbolIds` and/or `taskType` — returns ranked by confidence × recency × symbol overlap.
- **Remove**: `sdl.memory.remove` with `memoryId`; add `deleteFile: true` to also remove the `.sdl-memory/` file.
- **Automatic surfacing**: `sdl.slice.build` includes relevant memories by default. Set `includeMemories: false` to disable, or `memoryLimit: N` to control count.
- **Staleness**: after refactors, query `sdl.memory.query` with `staleOnly: true` and update or remove outdated memories.
- **Team sharing**: memories save to `.sdl-memory/` files; commit to Git. On `sdl.index.refresh`, other team members' files are imported into the graph.

### 12) Do not

- Do not jump directly to raw file reads if SDL tools can answer the question.
- Do not call `sdl.code.needWindow` before trying `sdl.code.getSkeleton`/`sdl.code.getHotPath`.
- Do not use broad `sdl.symbol.search` limits by default.
- Do not rebuild slices repeatedly when `sdl.slice.refresh` can provide incremental deltas.
- Do not call `sdl.symbol.getCard` N times when `sdl.symbol.getCards` can fetch all N in one call.
- Do not skip `sdl.agent.feedback` after completing a task — it improves future context quality.
- Do not call `sdl.runtime.execute` without setting `timeoutMs` — long-running processes will hang.
- Do not ignore `nextBestAction` in denied `code.needWindow` responses — it tells you what to try instead.
- Do not ignore stale memories surfaced in slices — review and update or remove them.
- Do not store trivial or ephemeral notes as memories — they add noise to future surfacing.
- Do not use `sdl.chain` for a single action — it adds overhead. Use the direct tool instead.
- Do not hardcode step indices in `$N` references without checking the actual step order in your chain.
```
