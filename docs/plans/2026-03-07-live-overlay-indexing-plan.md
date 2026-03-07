# Live Overlay Indexing and Reconciliation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace save-triggered repo-wide incremental reindexing with a live indexing architecture that accepts unsaved editor buffers, serves draft-aware graph results immediately, applies dependency-scoped graph patches on save, reconciles cross-file correctness in the background, and folds draft state into durable Kuzu state on save, idle, or explicit checkpoint.

**Architecture:** Keep Kuzu as the durable source of truth, add a per-repo in-memory overlay for draft file state, route editor updates through the existing HTTP and MCP server surfaces, patch file-owned symbols and edges transactionally on save, maintain a dirty frontier for dependent symbols/files, and run pass-2 plus broader graph maintenance asynchronously behind a reconciliation worker. Reads become overlay-aware so agent queries see draft state immediately without forcing full durability on every keystroke.

**Tech Stack:** TypeScript, Node.js, existing HTTP transport, MCP tool registry, VS Code extension, KuzuDB, Rust native indexer with TS fallback, node test runner with `tsx`.

---

## Working Assumptions

- Reuse the current server entrypoints in `src/cli/commands/serve.ts` and `src/cli/transport/http.ts` instead of adding a second daemon or websocket service in the first iteration.
- Keep the existing watcher in `src/indexer/watcher.ts`, but narrow its job to saved-file durability triggers and fallback sync when no editor integration is present.
- Treat Kuzu as durable state only. Unsaved buffers live in memory and are discarded on server restart unless they are checkpointed.
- Keep overlay ownership file-scoped. A file patch fully replaces the draft-owned symbol set and file-owned outgoing edges for that file instead of attempting per-symbol mutation.
- Make background reconciliation best-effort and observable. Draft reads must stay available even if pass-2 or enrichment jobs are behind.
- Preserve backward compatibility for current MCP clients. New draft-aware behavior is additive, with defaults that keep current CLI flows working.

## Target Architecture

### Write paths

- `Buffer push path`: editor sends open/change/save/close events with current text; server debounces parse work and refreshes in-memory draft graph state for that file.
- `Save patch path`: when a buffer is saved, the server transactionally replaces that file's symbols, references, and file-owned outgoing edges in Kuzu, then enqueues dependent files and symbols for background reconciliation.
- `Checkpoint path`: on save, idle, or explicit checkpoint, the server folds eligible draft overlay entries into Kuzu and trims overlay state.

### Read paths

- `Draft-aware symbol/card/slice reads`: query Kuzu first, then overlay-merge any touched files and symbols so draft results win for the active file and affected edges.
- `Status/diagnostics reads`: expose overlay health, dirty queue depth, last checkpoint, and reconciliation lag through repo status and doctor surfaces.

### Background paths

- `Reconciliation worker`: drains dirty files and symbols, reruns pass-2 cross-file resolution, refreshes dependent metadata, and schedules broader cluster/process recomputation when required.
- `Idle maintenance`: flushes stale draft state, prunes abandoned buffers, and performs checkpoint compaction when the repo is quiet.

## Task 1: Add the draft update contract and editor push channel

**Files:**
- Create: `src/live-index/types.ts`
- Create: `src/mcp/tools/buffer.ts`
- Modify: `src/mcp/tools/index.ts`
- Modify: `src/cli/transport/http.ts`
- Modify: `src/cli/commands/serve.ts`
- Modify: `sdl-mcp-vscode/src/extension.js`
- Test: `tests/unit/http-buffer-route.test.ts`
- Test: `tests/unit/mcp-buffer-tool.test.ts`
- Test: `tests/integration/vscode-buffer-push.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- the HTTP server accepts `open`, `change`, `save`, `close`, and `checkpoint` buffer events for a repo
- invalid payloads are rejected with typed errors
- MCP exposes an equivalent tool surface for non-HTTP clients
- the VS Code extension sends draft content on debounce and save without immediately calling repo-wide reindex

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/http-buffer-route.test.ts tests/unit/mcp-buffer-tool.test.ts tests/integration/vscode-buffer-push.test.ts
```

Expected: FAIL because no live buffer transport exists yet.

**Step 3: Define the contract**

Create `src/live-index/types.ts` with:
- `BufferEventType = 'open' | 'change' | 'save' | 'close' | 'checkpoint'`
- `BufferUpdateInput` including `repoId`, `filePath`, `language`, `version`, `content`, `dirty`, `cursor?`, `selections?`, and `timestamp`
- `BufferUpdateResult` including `accepted`, `overlayVersion`, `parseScheduled`, `checkpointScheduled`, and any `warnings`

Keep this contract transport-agnostic so both HTTP and MCP can reuse it.

**Step 4: Add transport handlers**

Modify `src/cli/transport/http.ts` to add:
- `POST /api/repo/:repoId/buffer`
- `POST /api/repo/:repoId/checkpoint`
- `GET /api/repo/:repoId/live-status`

Modify `src/mcp/tools/index.ts` and create `src/mcp/tools/buffer.ts` to expose:
- `sdl.buffer.push`
- `sdl.buffer.checkpoint`
- `sdl.buffer.status`

Keep handler logic thin. Route immediately into a live-index service layer rather than duplicating behavior in HTTP and MCP.

**Step 5: Update the VS Code extension**

Modify `sdl-mcp-vscode/src/extension.js` so:
- text document changes publish debounced buffer events
- save publishes a `save` event first, then optional checkpoint intent
- close publishes a `close` event
- the old save-triggered `/reindex` call becomes a fallback path when the live API is unavailable

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/http-buffer-route.test.ts tests/unit/mcp-buffer-tool.test.ts tests/integration/vscode-buffer-push.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/live-index/types.ts src/mcp/tools/buffer.ts src/mcp/tools/index.ts src/cli/transport/http.ts src/cli/commands/serve.ts sdl-mcp-vscode/src/extension.js tests/unit/http-buffer-route.test.ts tests/unit/mcp-buffer-tool.test.ts tests/integration/vscode-buffer-push.test.ts
git commit -m "feat: add editor buffer push channel"
```

## Task 2: Build the in-memory overlay store and draft parse pipeline

**Files:**
- Create: `src/live-index/overlay-store.ts`
- Create: `src/live-index/debounce.ts`
- Create: `src/live-index/draft-parser.ts`
- Modify: `src/indexer/parser/process-file.ts`
- Modify: `src/indexer/rust-process-file.ts`
- Modify: `src/cli/commands/serve.ts`
- Test: `tests/unit/overlay-store.test.ts`
- Test: `tests/unit/draft-parser.test.ts`
- Test: `tests/unit/overlay-debounce.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- overlay entries are stored per repo and file, with newer buffer versions replacing older ones
- debounced edits collapse multiple rapid `change` events into one parse job
- parsing unsaved content produces file-owned symbols, references, and outgoing edges without touching Kuzu
- closing a clean buffer evicts overlay state, while closing a dirty buffer keeps it until checkpoint or timeout policy says otherwise

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/overlay-store.test.ts tests/unit/draft-parser.test.ts tests/unit/overlay-debounce.test.ts
```

Expected: FAIL because the overlay layer does not exist.

**Step 3: Create the overlay store**

Create `src/live-index/overlay-store.ts` with:
- per-repo overlay maps keyed by normalized relative file path
- `upsertDraft`, `getDraft`, `removeDraft`, `listDirtyFiles`, `markCheckpointed`, `markSaved`
- version guards so stale editor events do not overwrite newer draft state
- timestamps for `lastEditAt`, `lastParseAt`, `lastSaveAt`, `lastCheckpointAt`

Keep file-owned graph fragments in memory:
- parsed file metadata
- symbol rows for the file
- outgoing edge rows owned by the file
- reference rows for the file
- unresolved call/import diagnostics for later reconciliation

**Step 4: Create the draft parse pipeline**

Create `src/live-index/draft-parser.ts` and `src/live-index/debounce.ts` so:
- buffer events schedule per-file parse jobs
- draft parsing reuses the same parser/indexer logic as saved files, but writes to overlay DTOs instead of Kuzu
- parse output records enough provenance to replace the file-owned durable rows later

Modify `src/indexer/parser/process-file.ts` and `src/indexer/rust-process-file.ts` only as needed to support a no-write draft mode that returns structured results.

**Step 5: Wire service startup**

Modify `src/cli/commands/serve.ts` to create one live-index coordinator per running server process and hand it to HTTP, MCP, and watcher components.

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/overlay-store.test.ts tests/unit/draft-parser.test.ts tests/unit/overlay-debounce.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/live-index/overlay-store.ts src/live-index/debounce.ts src/live-index/draft-parser.ts src/indexer/parser/process-file.ts src/indexer/rust-process-file.ts src/cli/commands/serve.ts tests/unit/overlay-store.test.ts tests/unit/draft-parser.test.ts tests/unit/overlay-debounce.test.ts
git commit -m "feat: add draft overlay store and parse pipeline"
```

## Task 3: Make graph reads overlay-aware for immediate draft visibility

**Files:**
- Create: `src/live-index/overlay-merge.ts`
- Create: `src/live-index/overlay-reader.ts`
- Modify: `src/db/kuzu-queries.ts`
- Modify: `src/mcp/tools/symbol.ts`
- Modify: `src/mcp/tools/slice.ts`
- Modify: `src/mcp/tools/repo.ts`
- Modify: `src/graph/slice.ts`
- Test: `tests/unit/overlay-merge.test.ts`
- Test: `tests/integration/draft-symbol-card.test.ts`
- Test: `tests/integration/draft-slice-build.test.ts`
- Test: `tests/integration/draft-search.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- a dirty unsaved buffer changes symbol-card output immediately
- slice building prefers overlay symbols and outgoing edges for touched files
- symbol search and repo status can surface draft-backed data without a save
- overlay entries shadow durable file-owned rows but do not corrupt unrelated Kuzu data

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/overlay-merge.test.ts tests/integration/draft-symbol-card.test.ts tests/integration/draft-slice-build.test.ts tests/integration/draft-search.test.ts
```

Expected: FAIL because current reads only see Kuzu state.

**Step 3: Implement overlay merge primitives**

Create `src/live-index/overlay-merge.ts` with deterministic rules:
- overlay wins for touched file-owned symbols, references, and outgoing edges
- deleted draft symbols suppress durable symbols from the same file
- untouched files and cross-file durable edges remain visible unless specifically shadowed

Create `src/live-index/overlay-reader.ts` that wraps current query results and applies merge rules for:
- symbol by id
- symbols by file
- symbol search result sets
- edge expansion for slices and blast radius inputs

**Step 4: Rewire read paths**

Modify the main MCP and graph read surfaces so they accept a live-index coordinator and use overlay-aware reads when available:
- `src/mcp/tools/symbol.ts`
- `src/mcp/tools/slice.ts`
- `src/mcp/tools/repo.ts`
- `src/graph/slice.ts`

Keep the raw Kuzu query layer simple. Overlay merging should happen above persistence, not inside Cypher statements.

**Step 5: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/overlay-merge.test.ts tests/integration/draft-symbol-card.test.ts tests/integration/draft-slice-build.test.ts tests/integration/draft-search.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/live-index/overlay-merge.ts src/live-index/overlay-reader.ts src/db/kuzu-queries.ts src/mcp/tools/symbol.ts src/mcp/tools/slice.ts src/mcp/tools/repo.ts src/graph/slice.ts tests/unit/overlay-merge.test.ts tests/integration/draft-symbol-card.test.ts tests/integration/draft-slice-build.test.ts tests/integration/draft-search.test.ts
git commit -m "feat: make graph reads draft aware"
```

## Task 4: Implement dependency-scoped graph patching for saved files

**Files:**
- Create: `src/live-index/file-patcher.ts`
- Create: `src/live-index/dependency-frontier.ts`
- Modify: `src/db/kuzu-queries.ts`
- Modify: `src/indexer/indexer.ts`
- Modify: `src/indexer/watcher.ts`
- Test: `tests/unit/file-patcher.test.ts`
- Test: `tests/unit/dependency-frontier.test.ts`
- Test: `tests/integration/saved-file-graph-patch.test.ts`
- Test: `tests/integration/watcher-save-fallback.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- saving one file replaces only that file's symbols, references, and outgoing edges in Kuzu
- the patch is transactional and leaves the previous durable state intact on failure
- directly dependent files and symbols are marked dirty for reconciliation
- the watcher fallback sends saved-file patch requests instead of triggering repo-wide incremental indexing

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/file-patcher.test.ts tests/unit/dependency-frontier.test.ts tests/integration/saved-file-graph-patch.test.ts tests/integration/watcher-save-fallback.test.ts
```

Expected: FAIL because the current save path still routes through `indexRepo(repoId, "incremental")`.

**Step 3: Build transactional file patching**

Create `src/live-index/file-patcher.ts` that:
- starts a Kuzu transaction
- deletes durable rows owned by the saved file
- inserts the latest parsed symbols, references, and outgoing edges from the overlay
- updates file metadata and content hash
- commits and returns the impacted symbol IDs and dependent frontier

Modify `src/db/kuzu-queries.ts` to add file-scoped delete and batch upsert helpers that make this transaction cheap and explicit.

**Step 4: Track dependency scope**

Create `src/live-index/dependency-frontier.ts` with logic that records:
- touched symbol IDs
- inbound dependents from durable Kuzu state
- imported/exported file relationships that may need pass-2 refresh
- high-level feature invalidations such as metrics, clusters, and processes

Use this frontier to enqueue only affected work instead of whole-repo reindex.

**Step 5: Rewire save behavior**

Modify `src/indexer/watcher.ts` so filesystem saves call the file patcher when live indexing is active.

Modify `src/indexer/indexer.ts` so repo-wide incremental mode remains available for fallback, but saved-file live updates prefer file patching and frontier enqueueing.

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/file-patcher.test.ts tests/unit/dependency-frontier.test.ts tests/integration/saved-file-graph-patch.test.ts tests/integration/watcher-save-fallback.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/live-index/file-patcher.ts src/live-index/dependency-frontier.ts src/db/kuzu-queries.ts src/indexer/indexer.ts src/indexer/watcher.ts tests/unit/file-patcher.test.ts tests/unit/dependency-frontier.test.ts tests/integration/saved-file-graph-patch.test.ts tests/integration/watcher-save-fallback.test.ts
git commit -m "feat: patch saved files into kuzu transactionally"
```

## Task 5: Add the background reconciliation worker for cross-file correctness

**Files:**
- Create: `src/live-index/reconcile-queue.ts`
- Create: `src/live-index/reconcile-worker.ts`
- Create: `src/live-index/reconcile-planner.ts`
- Modify: `src/indexer/cluster-orchestrator.ts`
- Modify: `src/indexer/indexer.ts`
- Modify: `src/mcp/tools/repo.ts`
- Test: `tests/unit/reconcile-queue.test.ts`
- Test: `tests/unit/reconcile-planner.test.ts`
- Test: `tests/integration/background-reconcile.test.ts`
- Test: `tests/integration/reconcile-cluster-process-refresh.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- dirty files and symbols are queued once and coalesced
- reconciliation reruns pass-2 and other dependent work for impacted files without a full repo index
- eventually consistent reads converge from draft-only edges to durable corrected edges after background work finishes
- cluster/process recomputation is scheduled only when impacted symbols cross the configured threshold

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/reconcile-queue.test.ts tests/unit/reconcile-planner.test.ts tests/integration/background-reconcile.test.ts tests/integration/reconcile-cluster-process-refresh.test.ts
```

Expected: FAIL because no background reconciliation service exists.

**Step 3: Build the queue and planner**

Create:
- `src/live-index/reconcile-queue.ts` for repo-scoped dirty sets, lease handling, dedupe, retries, and backoff
- `src/live-index/reconcile-planner.ts` for translating frontiers into concrete work items:
  - pass-2 file resolution
  - dependent edge repair
  - metrics refresh
  - cluster/process refresh when thresholded

Prefer idempotent work items so crashes do not corrupt state.

**Step 4: Build the worker**

Create `src/live-index/reconcile-worker.ts` that:
- drains the queue in the background
- reruns pass-2 for dirty files against current durable plus overlay state
- writes repaired cross-file edges and metadata back to Kuzu
- marks queue items complete, retryable, or failed with timestamps

Modify `src/indexer/indexer.ts` and `src/indexer/cluster-orchestrator.ts` to expose reusable sub-steps so the worker can call pass-2, metrics, clusters, and processes without invoking a full index run.

**Step 5: Expose status**

Modify `src/mcp/tools/repo.ts` so repo status returns:
- live overlay enabled
- dirty file count
- reconcile queue depth
- oldest queued item age
- last successful reconcile timestamp

**Step 6: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/reconcile-queue.test.ts tests/unit/reconcile-planner.test.ts tests/integration/background-reconcile.test.ts tests/integration/reconcile-cluster-process-refresh.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/live-index/reconcile-queue.ts src/live-index/reconcile-worker.ts src/live-index/reconcile-planner.ts src/indexer/cluster-orchestrator.ts src/indexer/indexer.ts src/mcp/tools/repo.ts tests/unit/reconcile-queue.test.ts tests/unit/reconcile-planner.test.ts tests/integration/background-reconcile.test.ts tests/integration/reconcile-cluster-process-refresh.test.ts
git commit -m "feat: add background graph reconciliation worker"
```

## Task 6: Fold overlay state into durable Kuzu on save, idle, and explicit checkpoint

**Files:**
- Create: `src/live-index/checkpoint-service.ts`
- Create: `src/live-index/idle-monitor.ts`
- Modify: `src/cli/commands/serve.ts`
- Modify: `src/cli/transport/http.ts`
- Modify: `src/mcp/tools/buffer.ts`
- Modify: `src/mcp/tools/repo.ts`
- Test: `tests/unit/checkpoint-service.test.ts`
- Test: `tests/unit/idle-monitor.test.ts`
- Test: `tests/integration/overlay-checkpoint.test.ts`
- Test: `tests/integration/explicit-checkpoint-api.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- save and idle policies trigger checkpoint attempts
- explicit checkpoint flushes eligible overlay entries into Kuzu and clears clean overlay state
- failed checkpoints leave draft data recoverable in memory and report a failed status
- repo status shows last checkpoint result and pending draft count

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/checkpoint-service.test.ts tests/unit/idle-monitor.test.ts tests/integration/overlay-checkpoint.test.ts tests/integration/explicit-checkpoint-api.test.ts
```

Expected: FAIL because no checkpoint service exists.

**Step 3: Implement checkpoint coordination**

Create `src/live-index/checkpoint-service.ts` that:
- identifies clean or saved draft entries eligible for fold
- uses the file patcher to write them durably
- waits for any required parse jobs to finish
- clears or compacts overlay state after successful fold
- records checkpoint status for diagnostics

Create `src/live-index/idle-monitor.ts` to trigger checkpoint scans when repo activity has been quiet for a configured interval.

**Step 4: Wire checkpoint triggers**

Modify:
- `src/cli/transport/http.ts` and `src/mcp/tools/buffer.ts` for explicit checkpoint requests
- `src/cli/commands/serve.ts` to start the idle monitor
- `src/mcp/tools/repo.ts` to return checkpoint metadata

**Step 5: Re-run tests**

Run:

```bash
node --import tsx --test tests/unit/checkpoint-service.test.ts tests/unit/idle-monitor.test.ts tests/integration/overlay-checkpoint.test.ts tests/integration/explicit-checkpoint-api.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/live-index/checkpoint-service.ts src/live-index/idle-monitor.ts src/cli/commands/serve.ts src/cli/transport/http.ts src/mcp/tools/buffer.ts src/mcp/tools/repo.ts tests/unit/checkpoint-service.test.ts tests/unit/idle-monitor.test.ts tests/integration/overlay-checkpoint.test.ts tests/integration/explicit-checkpoint-api.test.ts
git commit -m "feat: add overlay checkpoint and idle folding"
```

## Task 7: Add rollout guards, config, telemetry, and end-to-end regression coverage

**Files:**
- Modify: `src/config/types.ts`
- Modify: `config/sdlmcp.config.schema.json`
- Modify: `config/sdlmcp.config.example.json`
- Modify: `src/cli/commands/doctor.ts`
- Modify: `src/indexer/watcher.ts`
- Modify: `src/mcp/tools/repo.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Test: `tests/unit/live-index-config.test.ts`
- Test: `tests/unit/doctor-live-index-status.test.ts`
- Test: `tests/integration/live-index-e2e.test.ts`
- Test: `tests/unit/release-regressions.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:
- config validation supports live-index settings and safe defaults
- doctor reports whether live overlay, checkpointing, and reconciliation are available
- release regression checks guard against silently falling back to repo-wide incremental reindex on save
- a full end-to-end flow works: unsaved buffer update, draft-aware query, save patch, background reconcile, checkpoint, final durable read

**Step 2: Run the targeted tests**

Run:

```bash
node --import tsx --test tests/unit/live-index-config.test.ts tests/unit/doctor-live-index-status.test.ts tests/integration/live-index-e2e.test.ts tests/unit/release-regressions.test.ts
```

Expected: FAIL because config, telemetry, and end-to-end coverage are incomplete.

**Step 3: Add configuration and telemetry**

Modify `src/config/types.ts`, `config/sdlmcp.config.schema.json`, and `config/sdlmcp.config.example.json` to add:
- `liveIndex.enabled`
- `liveIndex.debounceMs`
- `liveIndex.idleCheckpointMs`
- `liveIndex.maxDraftFiles`
- `liveIndex.reconcileConcurrency`
- `liveIndex.clusterRefreshThreshold`

Modify `src/cli/commands/doctor.ts`, `src/indexer/watcher.ts`, and `src/mcp/tools/repo.ts` to expose:
- transport availability
- overlay counts
- parse failures
- reconcile failures and lag
- checkpoint success rate
- watcher fallback usage

**Step 4: Update docs**

Document:
- how the editor push path works
- what draft-aware reads guarantee
- when durable Kuzu catches up
- how to disable or tune live indexing
- operational expectations when the server restarts and draft overlays are lost before checkpoint

**Step 5: Re-run validation**

Run:

```bash
node --import tsx --test tests/unit/live-index-config.test.ts tests/unit/doctor-live-index-status.test.ts tests/integration/live-index-e2e.test.ts tests/unit/release-regressions.test.ts
npm run typecheck
npm test
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/config/types.ts config/sdlmcp.config.schema.json config/sdlmcp.config.example.json src/cli/commands/doctor.ts src/indexer/watcher.ts src/mcp/tools/repo.ts README.md AGENTS.md CHANGELOG.md tests/unit/live-index-config.test.ts tests/unit/doctor-live-index-status.test.ts tests/integration/live-index-e2e.test.ts tests/unit/release-regressions.test.ts
git commit -m "docs: finalize live overlay indexing rollout"
```

## Updated Test Strategy

Add or update tests in these layers:

- `Transport and contract`
  - HTTP route validation
  - MCP tool validation
  - VS Code extension live push behavior
- `Overlay correctness`
  - store semantics, version ordering, debounce collapse
  - draft parse output shape
  - overlay merge precedence for symbols, edges, and deletions
- `Durable patching`
  - file-scoped transactionality
  - dependency frontier accuracy
  - watcher fallback behavior
- `Background correctness`
  - reconcile queue dedupe, retries, and lag metrics
  - pass-2 dependent repair
  - cluster/process threshold refresh behavior
- `Durability and operations`
  - checkpoint success/failure
  - idle flush policy
  - doctor and repo status visibility
- `End-to-end`
  - unsaved draft visible immediately
  - save writes only file-scoped durable changes
  - background reconcile converges to correct cross-file graph
  - checkpoint clears overlay and leaves durable reads intact

Prefer fixture-backed integration tests over broad mocks once the transport and overlay contracts are stable.

## Execution Order

Implement tasks strictly in this order:
1. draft update contract and transport
2. overlay store and draft parse pipeline
3. overlay-aware reads
4. saved-file transactional patching
5. background reconciliation
6. checkpoint and idle folding
7. config, telemetry, docs, and end-to-end regressions

This order delivers immediate draft visibility first, then durable correctness, then operational hardening.

## Risks and Mitigations

- **Risk: overlay-aware reads diverge too far from durable Kuzu semantics**
  - Mitigation: keep merge rules file-scoped and deterministic; use integration tests that compare pre-save overlay reads and post-checkpoint durable reads.
- **Risk: file patching misses cross-file impacts**
  - Mitigation: dependency frontier records inbound dependents and import/export relationships; reconciliation remains mandatory after every save patch.
- **Risk: background work starves under rapid edits**
  - Mitigation: coalesce queue items by file and symbol, expose lag telemetry, and retain repo-wide incremental fallback for manual recovery.
- **Risk: editor integrations flood the server**
  - Mitigation: debounce parse work, reject stale versions, and cap overlay file counts per repo.
- **Risk: checkpointing unsaved drafts surprises users**
  - Mitigation: checkpoint only on save, idle policy, or explicit request; keep config flags visible and default behavior conservative.
- **Risk: cluster/process recomputation is too expensive for every save**
  - Mitigation: threshold and batch those refreshes behind reconciliation planning instead of doing them inline with file patches.

## Acceptance Criteria

- Unsaved editor buffers are queryable through HTTP and MCP-backed reads without saving to disk.
- Draft symbol cards, searches, and slices reflect overlay state within the debounce window.
- Saving a file patches only that file-owned durable graph rows in Kuzu.
- Dependent cross-file edges and derived data converge through background reconciliation without repo-wide incremental reindex in the normal path.
- Save, idle, and explicit checkpoint flows fold eligible overlay state into durable Kuzu and clear clean overlay entries.
- Repo status and doctor clearly report overlay health, reconcile lag, checkpoint status, and fallback usage.
- Updated unit and integration tests cover transport, overlay, patching, reconciliation, checkpointing, and the full end-to-end live indexing path.

## Recommended First Execution Slice

If this needs to be de-risked before full rollout, implement through Task 4 first. That yields the most important product change: unsaved draft visibility plus save-time file-scoped durable patching, while leaving background reconciliation and idle checkpointing for the second slice.
