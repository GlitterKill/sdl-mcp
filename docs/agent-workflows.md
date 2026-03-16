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
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

This page defines practical workflows for coding agents using SDL-MCP.

## Complete Tool Reference

SDL-MCP exposes 29 MCP tools across 12 categories. Every workflow on this page uses tools from this table.

| Category | Tool | Purpose |
|:---------|:-----|:--------|
| **Repository** | `sdl.repo.register` | Register a new repository for indexing |
| | `sdl.repo.status` | Get repo status, health metrics, watcher state, prefetch stats |
| | `sdl.index.refresh` | Trigger full or incremental re-indexing |
| | `sdl.repo.overview` | Token-efficient codebase overview (stats, directories, hotspots, clusters, processes) |
| **Live Buffers** | `sdl.buffer.push` | Push editor buffer content for draft-aware indexing |
| | `sdl.buffer.checkpoint` | Trigger a checkpoint to persist draft changes |
| | `sdl.buffer.status` | Check live buffer state (pending, dirty, queue depth) |
| **Symbols** | `sdl.symbol.search` | Search symbols by name or summary; supports semantic reranking |
| | `sdl.symbol.getCard` | Get a single symbol card with ETag caching |
| | `sdl.symbol.getCards` | Batch fetch up to 100 cards in one round trip |
| **Slices** | `sdl.slice.build` | Build graph slice from entry symbols or auto-discover from task text |
| | `sdl.slice.refresh` | Refresh an existing slice handle; returns incremental delta only |
| | `sdl.slice.spillover.get` | Paginated fetch for overflow symbols beyond budget |
| **Code Access** | `sdl.code.getSkeleton` | Deterministic skeleton IR (signatures + control flow, elided bodies) |
| | `sdl.code.getHotPath` | Hot-path excerpt: only lines matching specified identifiers |
| | `sdl.code.needWindow` | Full raw code window (gated — requires proof-of-need justification) |
| **Deltas** | `sdl.delta.get` | Delta pack between two versions with blast radius and fan-in trends |
| **Policy** | `sdl.policy.get` | Read current policy settings |
| | `sdl.policy.set` | Update policy (merge patch) |
| **Risk** | `sdl.pr.risk.analyze` | Analyze PR risk, blast radius, and recommend test targets |
| **Agent** | `sdl.agent.orchestrate` | Autonomous task execution with budget-controlled rung path planning |
| | `sdl.agent.feedback` | Record which symbols were useful/missing after a task |
| | `sdl.agent.feedback.query` | Query feedback records and aggregated statistics |
| **Context** | `sdl.context.summary` | Generate token-bounded summary for non-MCP contexts (clipboard, markdown, JSON) |
| **Runtime** | `sdl.runtime.execute` | Sandboxed subprocess execution (Node/Python/Shell) with structured output |
| **Memory** | `sdl.memory.store` | Store or update a development memory with symbol/file links |
| | `sdl.memory.query` | Search memories by text, type, tags, or linked symbols |
| | `sdl.memory.remove` | Soft-delete a memory from graph and optionally from disk |
| | `sdl.memory.surface` | Auto-surface relevant memories ranked by confidence, recency, and symbol overlap |

---

## Paste-Ready AGENTS.md Block

Copy this block into `AGENTS.md` for token-efficient SDL-MCP usage on the current codebase/tooling. Replace `[repoid]` with your repo's ID.

```md
## SDL-MCP Token-Efficient Protocol (v0.8)

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
3. `sdl.symbol.getCard` for single lookups; send `ifNoneMatch` to get `notModified` responses. Use `sdl.symbol.getCards` (batch, up to 100 IDs) when fetching multiple symbols at once — one round trip instead of many.
4. `sdl.slice.build` with explicit budget and compact output:
   - Keep `wireFormat: "compact"` (default) and `wireFormatVersion: 2` (default).
   - Set budget early, for example: `{ "maxCards": 30, "maxEstimatedTokens": 4000 }`.
   - Use `minConfidence` to drop low-trust edges (default `0.5`; adaptive thresholds can tighten to `0.8` and `0.95` as token usage approaches budget).
   - Always provide `entrySymbols` when available.
   - Provide `knownCardEtags` to avoid resending unchanged cards (`cardRefs` are returned instead).
   - Leave `cardDetail` unset for mixed compact/full behavior. Use `"full"` only when you truly need full cards for all slice symbols.
   - **Auto-discovery mode**: pass `taskText` (and optionally `stackTrace`, `failingTestPath`, or `editedFiles`) instead of `entrySymbols` to let SDL-MCP find relevant symbols automatically.
5. `sdl.slice.refresh` if you already have a `sliceHandle`; prefer refresh over rebuilding.
6. `sdl.slice.spillover.get` only when necessary; keep `pageSize` small (default `20`, max `100`).
7. `sdl.code.getSkeleton` before `hotPath` or raw windows. In file mode, prefer `exportedOnly: true` when possible.
8. `sdl.code.getHotPath` with focused identifiers (`1-3` identifiers, low `contextLines`, default `3`).
9. `sdl.code.needWindow` last. Keep requests tight:
   - `expectedLines <= 180`
   - `maxTokens <= 1400`
   - Non-empty `identifiersToFind` (required by policy)

### 2) Task-specific workflows

- **Debug**: `search -> card -> slice.build -> hotPath -> needWindow (only if still ambiguous)`.
- **Debug (auto-discovery)**: `slice.build` with `taskText` describing the bug + `stackTrace` if available → SDL-MCP finds symbols automatically.
- **Feature implementation**: `repo.overview -> search -> card -> slice.build`.
- **PR review**: `delta.get -> pr.risk.analyze -> card/hotPath for high-risk symbols`.
- **Live editing**: `buffer.push` as files change → `buffer.checkpoint` to persist → search/card/slice now reflect draft state.
- **Context export**: `context.summary` with `format: "clipboard"` to produce a summary for non-MCP tools.
- **Test execution**: `runtime.execute` with `runtime: "node"` or `"shell"` to run tests and capture structured output.

### 3) Token controls by tool

- `sdl.repo.overview`:
  - `level: "stats"` is cheapest.
  - `level: "full"` auto-enables hotspots unless overridden.
  - Use `directories`, `maxDirectories`, and `maxExportsPerDirectory` to bound payload.
- `sdl.symbol.search`:
  - Keep `limit` low (5–20) to start. Increase only if no results match.
  - `semantic: true` adds ~50ms latency but dramatically improves relevance for conceptual queries.
- `sdl.slice.build`:
  - Keep `minConfidence` near `0.5` for recall-oriented work and raise it for precision-focused runs.
  - Slice cards filter `deps.calls`/`deps.imports` to only in-slice symbols and include per-dependency confidence scores.
  - Use `wireFormatVersion: 3` for grouped edge encoding when slices exceed 50 cards.
- `sdl.delta.get`:
  - Pass `budget` for large version diffs to constrain blast-radius work.
- `sdl.pr.risk.analyze`:
  - Raise `riskThreshold` (for example `80`) to focus on highest-risk changes.
- `sdl.context.summary`:
  - Set `budget` to cap output tokens. Use `scope: "task"` for multi-symbol summaries, `scope: "symbol"` for single-symbol.
- `sdl.runtime.execute`:
  - Set `timeoutMs` and `maxResponseLines` to bound output. Use `queryTerms` to extract relevant excerpts from long output.

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

- **Runtimes**: `"node"`, `"python"`, `"shell"`.
- Use `code` to run inline code or `args` to invoke a file.
- `queryTerms` extracts only matching lines from output (like a built-in grep).
- `persistOutput: true` saves full output to an artifact handle for later retrieval.

### 7) Context export (`sdl.context.summary`)

Generate a token-bounded summary for contexts that don't support MCP tool calls (e.g., pasting into a chat, a PR description, or a ticket).

```json
{
  "repoId": "[repoid]",
  "query": "authentication flow",
  "budget": 2000,
  "format": "clipboard",
  "scope": "task"
}
```

- **Formats**: `"markdown"` (default), `"json"` (structured), `"clipboard"` (paste-ready).
- **Scopes**: `"symbol"` (single symbol), `"file"` (all exports in a file), `"task"` (multi-symbol via search).

### 8) Feedback loop

After completing a task, record what worked:

```json
{
  "repoId": "[repoid]",
  "versionId": "<from sdl.repo.status>",
  "sliceHandle": "<from sdl.slice.build>",
  "usefulSymbols": ["<id1>", "<id2>"],
  "missingSymbols": ["<id3>"],
  "taskType": "debug",
  "taskText": "Fix auth token expiry bug"
}
```

This trains the slice ranker over time and improves context quality for the repo.

To review recorded feedback later (e.g., for tuning or reporting):

```json
sdl.agent.feedback.query({
  "repoId": "[repoid]",
  "limit": 50,
  "since": "2026-03-01T00:00:00Z"
})
```

Returns aggregated stats on which symbols are most frequently useful/missing.

### 9) Policy management

Read current gating thresholds:

```json
sdl.policy.get({ "repoId": "[repoid]" })
```

Adjust policy for the session (merge patch — only supplied fields change):

```json
sdl.policy.set({
  "repoId": "[repoid]",
  "policyPatch": {
    "maxWindowLines": 250,
    "allowBreakGlass": false
  }
})
```

Common adjustments:
- Raise `maxWindowLines`/`maxWindowTokens` for large functions.
- Set `allowBreakGlass: false` to enforce strict proof-of-need gating.
- Set `requireIdentifiers: false` to allow unscoped code window requests (not recommended).

### 10) Development memories

Store cross-session knowledge and retrieve it automatically:

- **After a debugging session**: store a `bugfix` memory linked to the relevant symbols.
  ```
  sdl.memory.store({ repoId, type: "bugfix", title: "Race condition in authenticate()",
    content: "...", symbolIds: ["sym_abc"], tags: ["auth", "concurrency"] })
  ```
- **After an architectural decision**: store a `decision` memory.
  ```
  sdl.memory.store({ repoId, type: "decision", title: "Use mutex for session store",
    content: "...", symbolIds: ["sym_sessionStore"], confidence: 0.95 })
  ```
- **Automatic surfacing**: `sdl.slice.build` includes relevant memories by default.
  Set `includeMemories: false` to disable, or `memoryLimit: N` to control count.
- **Review stale memories**: after refactors, query `sdl.memory.query({ repoId, staleOnly: true })`
  and update or remove outdated knowledge.
- **Surface for current task**: `sdl.memory.surface({ repoId, symbolIds: [...], limit: 5 })`
  returns the most relevant memories ranked by confidence × recency × symbol overlap.
- **Team sharing**: memories are saved to `.sdl-memory/` files that can be committed to Git.
  On the next `sdl.index.refresh`, other team members' files are imported into the graph.

### 11) Do not

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
```
