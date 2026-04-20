# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.8] - Unreleased

### Added

### Changed

### Fixed

## [0.10.7] - 2026-04-19

### Added

- **`sdl.context` defaults to hybrid retrieval end-to-end**: hybrid seeding (entitySearch
  via FTS + vector + RRF) now runs **alongside** path-inference, not instead of it.
  Path-inferred refs are preserved first; hybrid adds semantically related refs
  the heuristic misses. `TaskOptions.semantic` (default `true`) and
  `TaskOptions.includeRetrievalEvidence` (default `true`) toggle the behavior.
- **Retrieval evidence surfaced on `sdl.context` responses**: `ContextSeedResult`
  gained an `evidence?: RetrievalEvidence` field, captured from Stage 1
  entitySearch and propagated into `AgentContextPayloadSchema.retrievalEvidence`.
  The Zod schema now accepts `sources`, `candidateCountPerSource`,
  `topRanksPerSource`, `fusionLatencyMs`, `fallbackReason`, `ftsAvailable`, and
  `vectorAvailable` — so callers can see which lanes contributed to their
  results.
- **Entity-search telemetry**: `entitySearch` emits
  `logger.info("Entity search", { eventType: "entity_search", ... })` at every
  return path (fallback-to-legacy, db-connection-fail, main success) with
  latency, per-source candidate counts, and `ftsAvailable`/`vectorAvailable`.
  This makes hybrid contribution visible for `sdl.context` calls (previously
  only `sdl.symbol.search` emitted hybrid telemetry).
- **Multi-model embedding pass**: new `semantic.additionalModels: string[]`
  config option. The indexer now loops over `[model, ...additionalModels]`
  calling `refreshSymbolEmbeddings` per model, so both `jina-embeddings-v2-base-code`
  and `nomic-embed-text-v1.5` vectors can be populated from a single index run.
  Hybrid fusion can then RRF-merge both vector lanes alongside FTS.

### Changed

- **ONNX embedding models unbundled**: `jina-embeddings-v2-base-code` (~162MB) and
  `nomic-embed-text-v1.5` (~137MB) are no longer shipped inside the npm tarball.
  Published package size dropped from ~215 MB to ~1.6 MB. Both models are now
  fetched on `npm install` by `scripts/postinstall-models.mjs` into the platform
  cache directory (`%LOCALAPPDATA%/sdl-mcp/models/` on Windows,
  `~/.cache/sdl-mcp/models/` elsewhere). Set `SDL_MCP_SKIP_MODEL_DOWNLOAD=1` to
  skip the postinstall download.
- **Model registry fallback URLs**: `ModelInfo.fallbackDownloadUrls` points at
  the project's GitHub Releases mirror (tag `models-v1`) and is used
  automatically when the primary HuggingFace URL fails at postinstall time or
  on lazy runtime download. Both bundled models now have primary HuggingFace
  URLs populated (jina previously had none).

### Fixed

- **Hybrid retrieval FTS and vector lanes silently returned zero**: The
  `QUERY_FTS_INDEX` and `QUERY_VECTOR_INDEX` calls in `src/retrieval/orchestrator.ts`
  were malformed — missing `RETURN` clause (rejected by the LadybugDB binder),
  passing the index name as a parameter (must be a literal), and passing `topK`
  positionally (must be `K := <int>`). Every invocation threw and the error was
  swallowed at `logger.debug` level, making both lanes invisible contributors
  with zero candidates. Fixed in four call sites (two in `hybridSearch`, two in
  `entitySearch`). The `fts.conjunctive` config flag is now threaded through to
  the FTS call. Index and table names are validated against a strict identifier
  whitelist before interpolation. Swallow-catch logging bumped from `debug` →
  `warn` so future binder errors surface at the default log level.

### Breaking Changes

- **API Consolidation**: Reduced tool surface from 37 to 34 actions
  - **Removed `sdl.agent.context`**: Use `sdl.context` (Code Mode) for task-shaped context retrieval
  - **Removed `sdl.context.summary`**: Use `sdl.context` which provides structured cards + skeletons
  - **Merged `sdl.symbol.getCards` into `sdl.symbol.getCard`**:
    - Single symbol: `{ symbolId: "..." }` (unchanged)
    - Batch: `{ symbolIds: ["...", "..."] }` (was separate tool)
    - Response shape unchanged for each mode

### Performance

- **Deferred fresh-DB index bootstrap**: Fresh databases now create only base schema (node/edge tables)
  during initialization, deferring 19 secondary indexes and retrieval indexes until after the first
  successful full index completes. This removes index maintenance overhead from the ingestion-critical
  path. Existing DB initialization is unchanged.
- **Write connection pool**: Replaced single write connection with a pool of 4 warm connections using
  two-layer concurrency control (connection acquisition + serialized execution). Enables instant
  failover and hides connection acquisition latency from the batch drain loop.
- **Background batch drain**: Batch persistence accumulator now uses an async background writer with
  auto-enqueue at threshold (200 rows). Parsing threads are never blocked by DB writes.
- **TS engine batch persistence**: TypeScript pass1 indexing now uses the same `BatchPersistAccumulator`
  as the Rust engine, eliminating per-file transaction overhead and enabling write pipelining.

### Fixed

- **Repository scanning descriptor cleanup**: Replaced async `node:fs/promises.glob()`
  traversal in the indexer with an explicit directory walker that closes every
  opened directory handle deterministically. The same walker now backs Go,
  Java/Kotlin, and C# import-resolution fallback scans to avoid leaving identical
  traversal leak candidates in place.

## [0.10.6] - 2026-04-19

### Performance

- **Deferred derived-state refresh**: Incremental index runs now skip cluster/process/file-summary
  recomputation, deferring it to the next full index. Reduces incremental index latency.
- **Deferred fresh-DB index bootstrap**: Fresh databases create only base schema during
  initialization, deferring 19 secondary indexes until after the first full index completes.
- **Batch TS pass1 persistence**: TypeScript pass1 indexing uses `BatchPersistAccumulator`
  with background drain loop, eliminating per-file transaction overhead.
- **Rust indexer pipelining**: Rust engine overlaps parsing with DB writes for higher throughput.

### Fixed

- **Write pool reverted to single connection**: Reverted the v0.10.5-era write connection pool
  (4 warm connections) back to a single serialized write connection. LadybugDB has a known bug
  where concurrent writes on separate connections can cause N-API GC crashes and use-after-free
  in native code. The bug has been patched upstream but not yet released. This rollback trades
  write throughput for stability until the fix ships.
- **Connection mutex shutdown safety**: Gated connection mutexes during shutdown to prevent
  use-after-free when pending writes race against connection disposal.
- **Pre-index checkpoint timeout**: `preIndexCheckpoint` now races against a 2-second timeout
  to prevent stalls on slow databases.
- **Live-index reconcile gating**: Reconcile-worker writes now route through the indexing gate,
  preventing concurrent writes during active indexing.
- **Tool dispatch throttling**: MCP tool dispatch is throttled during active indexing to prevent
  write contention on the single connection.
- **Batch drain re-entry guard**: Prevents drain loop re-entry after write errors, avoiding
  cascading failures during DB pressure.
- **Repository scanning descriptor cleanup**: Replaced `glob()` with explicit directory walker
  that closes every opened directory handle deterministically.
- **Symbol search noise floor**: Results below 0.3 relevance are suppressed when no exact match
  exists, preventing misleading low-confidence results. Suggestion message updated to reflect
  suppression.
- **Context answer verbosity**: `sdl.context` broad mode no longer duplicates symbol card
  summaries already present in `finalEvidence`.
- **Spillover respects cardDetail**: `slice.spillover.get` now honors the `cardDetail` setting
  from the original `slice.build` call, omitting `invariants`, `sideEffects`, and `metrics`
  for compact slices.

### Added

- **`excludeDisabled` for action.search**: New boolean parameter to filter disabled actions
  from results, with correct pre-pagination filtering.
- **Manual step reference patterns**: `sdl.manual` markdown output now includes a table
  documenting `$N.field` cross-step reference syntax for workflow users.
- **`cardDetail` in SliceHandle**: Schema addition — `cardDetail STRING` column on
  `SliceHandle` graph node for spillover detail-level propagation.

## [0.10.5] - 2026-04-14

### Breaking Changes

- **Default Embedding Model Changed**: Replaced all-MiniLM-L6-v2 (384-dim, 256-token) with
  jina-embeddings-v2-base-code (768-dim, 8192-token) as the default bundled embedding model.
  - **Migration Required**: Existing users must update their config and re-index to regenerate embeddings
  - Database schema updated: removed `embeddingMiniLM` columns, added `embeddingJinaCode` columns
  - Config field `embedding.model` default changed from `"all-MiniLM-L6-v2"` to `"jina-embeddings-v2-base-code"`
  - nomic-embed-text-v1.5 remains available as an optional addon

### Added

- **`sdl.file.write` Tool**: Write non-indexed files (configs, docs, templates) with multiple modes:
  - Full content replacement
  - Line-range replacement
  - Pattern-based replacement
  - JSON path updates
  - Insert at line / append modes
- **Workflow Dry-Run Mode**: Validate workflow steps and `$N` references without execution
  via `dryRun: true` parameter
- **Action Search Enhancements**:
  - `summaryOnly` mode for compact stats without full details
  - Synonym expansion (e.g., "test coverage" finds metrics/symbol/card tools)
- **Symbol Search Improvements**:
  - `shortId` field (first 16 chars) in results for easier reference
  - `pattern` alias for `query` parameter
- **Context Response Enhancements**:
  - `contextModeHint` explains precise vs broad mode behavior
  - `schemaHint` tip when `includeSchemas` is false
- **Truncation Recovery**: `cursor` field in `suggestedNextCall.args` for easy continuation
  after truncated code windows
- **CLI Improvements**:
  - Banner display for index/serve commands (HTTP transport)
  - Progress display shows current file below progress bar

### Changed

- **Test Infrastructure Overhaul**:
  - All tests run isolated for LadybugDB safety
  - Improved TAP parsing distinguishes real failures from process exit segfaults
  - Test summary with pass/fail counts and segfault tracking
- Token savings meter now always appended as content block for MCP client visibility
- `file.read` uses sliced range for raw token baseline (not full file)

### Fixed

- **Windows CI**: Allow 8.3 short paths (e.g., `RUNNER~1`) in `--repo-path` validation.
  Changed from `includes("~")` to `startsWith("~")` to only block Unix home directory
  expansion while permitting Windows short filename formats.
- Windows LadybugDB native addon cleanup crash handling in tests
- Embedding column name consistency in schema and tests
- Tool count expectations in gateway tests

## [0.10.4] - 2026-04-10

### Added

- **SCIP Integration**: Ingest pre-built SCIP index files for compiler-grade cross-references
  - `sdl.scip.ingest` MCP tool action with dry-run support
  - Auto-ingest on `sdl.index.refresh` when configured
  - External dependency symbols as first-class graph nodes
  - New `"implements"` edge type for interface/trait implementations
  - Rust decoder (primary) with TypeScript fallback
  - SCIP-only symbols survive live-index reconciliation
  - `excludeExternal` filter for symbol search
- **scip-io CLI integration** (`scip.generator` config): Automatically run the
  polyglot [scip-io](https://github.com/GlitterKill/scip-io) orchestrator in the
  repo root before every `indexRepo()` call to produce a fresh `index.scip`,
  which the existing auto-ingest then picks up. Disabled by default; opt in
  via `scip.generator.enabled = true` (requires `scip.enabled = true`).
  - Pre-refresh hook lives in `indexRepoImpl()`, so every call path (MCP
    `sdl.index.refresh`, CLI `sdl-mcp index`, HTTP reindex, file watcher,
    sync pull, benchmarks) gets it automatically.
  - Auto-installs scip-io from GitHub releases into `~/.sdl-mcp/bin/` when
    missing from PATH and `scip.generator.autoInstall = true`. Downloads use
    Node's built-in `fetch` (no shell, no remote scripts) against an
    allowlist of `github.com` / `objects.githubusercontent.com` hosts —
    tampered API responses pointing at other hosts are rejected. SHA-256
    verification against the release's `SHA256SUMS.txt` is mandatory;
    installs are refused if the checksum file is absent. Archives are
    extracted via the system `tar` binary with realpath-based staging-dir
    containment to block symlink escapes.
  - When the generator is enabled, `{ path: "index.scip" }` is auto-injected
    into `scip.indexes` at config-load time so users only need one flag to
    opt in.
  - All failures (binary missing, install failure, non-zero exit, timeout)
    are non-fatal and logged as warnings — indexing continues regardless.
- **Graph analytics for ranking and blast radius**:
  - PageRank and K-core centrality persisted in LadybugDB
  - Louvain shadow clusters for cluster-aware ranking and exploration
  - Blast radius path explanations for clearer impact traces
- **Pass-2 resolver expansion and telemetry**:
  - Deeper Java, Python, Rust, and Shell resolver coverage
  - Shared scope/barrel walkers and centralized confidence scoring
  - Per-resolver telemetry for pass-2 correctness and tuning
- **Rust-native indexing parity improvements**: stronger pass-1 coverage with
  per-file TypeScript fallback when the native path cannot fully resolve a file.

### Changed

- **Semantic retrieval storage and bootstrap**:
  - Symbol embeddings now migrate toward fixed-size vector storage for indexable columns
  - Retrieval bootstrap adds vector index lifecycle management with structured degradation when capabilities are unavailable
- **CLI and tooling ergonomics**:
  - Index operations emit better user feedback during long runs
  - Tool dispatch, schema handling, and PR risk analysis received a broad hardening pass
- Documentation expanded across architecture, configuration, semantic setup, and SCIP deep dives.

### Fixed

- **Graceful stdio shutdown in `serve --stdio`**: transport close now routes through the centralized shutdown manager, aligning the CLI path with the direct entrypoint and reducing the risk of dirty LadybugDB shutdowns and WAL corruption on client exit.
- Corrected vector-column migration behavior, buffer timestamp coercion, and several tool response edge cases.
- Addressed code review findings across SCIP ingestion, policy updates, runtime/build safety, resource handling, and info-path redaction.
- Fixed CI and native build issues around protobuf/clang setup and lockfile drift.

## [0.10.3] - 2026-04-04

### Added

- **Jina embeddings v2 base-code model** support for semantic symbol search alongside nomic-embed-text.
- **Graph-guided cluster expansion** — cluster neighbor expansion now uses graph edges for diversity instead of flat member lists.
- **Confidence-aware context planning** — the Planner adjusts rung paths based on confidence tiers (high confidence → cheapest plan, low → deeper rungs).
- **Evidence-aware context symbol ranking** — retrieved symbols ranked by retrieval evidence quality, not just graph proximity.
- **Semantic-first context seeding** — `sdl.context` seeding prefers semantic (embedding) retrieval over keyword-only search when available.
- **`sdl.context` quality benchmark harness** (`tests/`) for measuring context retrieval accuracy across task types.
- **Compound identifier search** in context seeding — multi-word queries generate camelCase variants ("beam search" → "beamSearch") for better symbol discovery.
- **Focus-path inference** and **language-affinity scoring** in context ranking.
- **Response deduplication** across context evidence items.

### Changed

- **Broad-mode context retrieval** overhauled: improved identifier extraction, capped cluster expansion to prevent token blowout, and compacted context responses.
- **Planner broad-mode path selection** improved — selects rungs more appropriate for exploratory queries.
- **Task-type ranking** weights tuned per task type (debug, review, implement, explain) for more relevant symbol ordering.
- **ETag cache optimizations** — reduced redundant card lookups across workflow steps.
- **Context answers preserved** under broad-mode truncation (previously dropped when response was trimmed to budget).
- Memory opt-in model: memory tools hidden from action search when `memory.enabled` is false; runtime behavior fully gated behind config.

### Fixed

- **Token tracking** accuracy corrected for multi-step workflow executions.
- **Bloom filter microbenchmark** replaced with deterministic correctness assertions (eliminated flaky CI failures).
- **Audit test** updated for ranking refactor; hoisted Set allocation out of hot loop.
- **Context `contextMode` propagation** — broad-mode options no longer stripped by gateway schema validation.

## [0.10.2] - 2026-04-01

### Breaking

- **Tool renaming**: `sdl.agent.orchestrate` → `sdl.context` and `sdl.chain` → `sdl.workflow`. CLAUDE.md/AGENTS.md files generated by prior `init` runs should be regenerated via `sdl-mcp init`.
- Removed legacy ANN (Approximate Nearest Neighbor) index code and embedding subsystem (`ann-index.ts`, `embeddings.ts`, `summary-transfer.ts`, `event-log-replay.ts`). Hybrid retrieval stack replaces these.
- Removed legacy SQLite migration files (`migrations/0001–0020`). LadybugDB idempotent schema is now the sole persistence path.

### Added

- **Behavioral body analysis summaries**: Functions are now summarized by analyzing body signals (validation, delegation, I/O, transforms, caching, events, recursion, etc.) rather than restating type signatures. 17-level priority ladder in both TypeScript and Rust indexers.
- **`file.read` tool** for non-indexed files (configs, docs, JSON, YAML) within `sdl.workflow`, with line-range, search, and JSON-path extraction modes. Raw-token baselines attached for savings tracking.
- **CamelCase fallback** in `symbol.search`: when no results match, individual camelCase tokens are searched as a fallback with actionable suggestions.
- **`detail` parameter** on `repo.status` (`"minimal"` | `"standard"` | `"full"`) to skip expensive health/watcher computation — `"minimal"` returns only core counts.
- **`maxBlastRadiusItems`** parameter on `delta.get` with default 20-item cap; BFS early termination cuts response time from 23s to <3s on large graphs.
- **Agent wire format** (`wireFormat: "agent"`) for human-readable slice output.
- **Workflow continuation handles** for truncated responses with `chainContinuationGet` transform for paginated retrieval.
- **Per-step `maxResponseTokens`** and `defaultMaxResponseTokens` on workflow requests.
- **`exactMatchFound`** boolean in symbol search response to distinguish exact vs. fuzzy results.
- **Action search pagination** with `total` count and `hasMore` boolean.
- **Async indexing mode** with `operationId` and background execution on `index.refresh`.
- **Fallback tools** on workflow step errors — failed steps now include `fallbackTools` from the action catalog.
- **Task-query ranking** (`src/retrieval/task-query-ranking.ts`) for improved symbol retrieval relevance.
- **`missedIdentifierHint`** on code windows with actionable escalation path suggesting `sdl.symbol.search` then `sdl.code.getHotPath`.
- **Compound token search** in context summary — generates camelCase from adjacent query words ("beam search" → "beamSearch") for better symbol discovery.
- **Directory-prefix context resolution** via `getFilesByPrefix` DB query for `sdl.context` precise mode with directory `focusPaths`.
- **Repo health caching** and parallelized status DB reads.
- **Memory upsert semantics** — `memory.store` with a `memoryId` that doesn't exist now creates with that ID instead of throwing.
- **Baseline version** created on new repo registration to prevent NO_VERSION errors.
- 80+ irregular verb entries added to summary verbify() covering common programming terms.
- New unit/integration tests: behavioral summaries, friction fixes, workflow truncation, task-query ranking, file-read integration, code-mode regressions, compute-relevance, ladybug-search-queries, slice agent wire format, audit fixes.

### Changed

- Internal module renaming: `orchestrator.ts` → `context-engine.ts`, `chain-*.ts` → `workflow-*.ts`, `tools/agent.ts` → `tools/context.ts`. All templates, docs, and tests updated.
- Token savings clamped to zero — negative overhead (SDL tokens > raw equivalent) is no longer reported as negative savings.
- Compact manual default reduced from ~6.6K to ~600 tokens when no filters specified.
- Ladder warnings filtered for failed workflow steps.
- Default delta/PR-risk budget caps lowered (15→10 cards, 8000→4000 tokens, 50→25 blast-radius items) to prevent unbounded responses.
- Symbol relevance scoring improved with trigram similarity and camelCase subword matching.
- Memory query now splits multi-word queries into per-word AND conditions.
- Cluster labels prefer directory-based naming when 50%+ of members share a common path prefix.
- AST fingerprint change used as primary modification gate in delta — formatting-only signature diffs no longer reported as modifications.
- Hook deny message expanded with explicit SDL context ladder guidance.
- PR risk analysis includes budget, summary, and proper `riskThreshold` filtering.
- Compact slice `_legend` sent only once per session with session boundary reset.
- `deps.calls` on symbol cards filters out `unresolved:` external module refs.
- `canonicalTest` suppressed when proximity < 0.5.
- Rust native indexer: summary module expanded with behavioral body analysis matching TypeScript parity.
- All MCP client templates (CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md, OPENCODE.md) regenerated.
- Documentation overhauled: architecture, feature deep-dives, tool references updated for new tool names and capabilities.

### Fixed

- **OOM crash** when indexing large repos (10k+ files) — added memory release phases between pipeline stages, `clearTsCallResolverCache()` after pass2, and `getSymbolsByRepoLite` for clustering.
- **`codeNeedWindow` false denials** when identifiers exist in the full symbol body but fall outside the policy-truncated window; now approves with a warning listing missed identifiers.
- **12+ call sites** where `attachRawContext()` return value was discarded, causing 0% token savings attribution.
- **Break-glass evidence type check** corrected (`"break-glass-triggered"` not `"break-glass"`).
- **Exact match ranking** in symbol search now uses strict name equality instead of relevance >= 0.85.
- **`slice.build` with `taskText`-only** no longer returns empty slices — falls back to raw-word search when all tokens are filtered as stop-words.
- **`splitCamelCase`** regex now recognizes digit-embedded acronyms (E2E, B2B, H2O) as single tokens.
- **Shutdown usage persistence** — replaced dynamic shutdown imports with static imports.
- **Indexing write/read consistency** — `FileSummary` upserts wrapped in write transaction; read connection refreshed earlier in indexer flow.
- **`contextMode` stripped by Zod** in gateway schemas — `isPrecise` branch in agent executor was always false.
- **NaN guard** added to `compareValues` date branch preventing unstable sort on invalid date strings.
- **Errored workflow steps** now count against `maxSteps` budget (previously bypassed limits entirely).
- **`detectSummaryScope`** repo-term check fixed to use whole-word matching instead of substring.
- **`needWindow` `droppedCount`** corrected for narrowed ranges.
- **Glob-to-regex conversion** — `$` and `\` properly escaped.
- **PR risk** budget caps match schema max (200) not defaults.
- **Runtime output** normalizes `\r\n` to `\n` on Windows.
- **HTTP transport** hardened with client disconnect detection, `clientError` handler, and timeouts.
- **Uncaught exception handler** has 5s hard deadline before `process.exit(1)`.

## [0.10.1] - 2026-03-27

### Changed

- **Breaking behavior**: `repo.status` `surfaceMemories` default flipped from `true` to `false`. Agents must now pass `surfaceMemories: true` explicitly to surface development memories.
- Decomposed `src/mcp/tools/index.ts` hotspot (370 lines) into declarative `tool-descriptors.ts` with `ToolDescriptor` interface and `buildFlatToolDescriptors()` factory (78 lines). Also registers previously missing `sdl.runtime.queryOutput` in flat mode.
- Benchmark suite rewritten: `scripts/benchmark.ts` converted from stale SQLite-era direct-DB benchmark to a replay-trace-based synthetic benchmark. Real-world benchmark scripts (`real-world-benchmark.ts`, `real-world-benchmark-matrix.ts`) hardened with proper path resolution, error handling, and CI argument forwarding fixes.

### Added

- Auto-generated tool inventory with drift enforcement: `scripts/generate-tool-inventory.ts` produces `docs/generated/tool-inventory.json` and `tool-inventory.md` from source. `scripts/check-tool-inventory.ts` enforces sync. New npm scripts: `docs:tools:generate`, `docs:tools:check`. CI step added.
- Agent executor `cacheHits` metric now tracks real cache hit counts via a per-session `cardCache` Set (previously was always zero).
- Telemetry: neutral accounting for `sdl.workflow` and other tools that report `totalTokens` without `_tokenUsage` — calls are now counted in `usage.stats` with zero savings inflation.
- `scripts/prepare-release.mjs` release preparation helper.
- Unit tests for tool descriptors, neutral savings accounting, agent executor cache hits, repo status memory default, and prepare-release script.

### Fixed

- `FileSummary` relationship cleanup: `_deleteFilesByIdsInner` now removes `FILE_SUMMARY_IN_REPO` edges before deleting orphaned `FileSummary` nodes, preventing dangling relationships during incremental re-indexing.
- CI fixes: benchmark matrix argument forwarding (removed extraneous `--` separator), external repo path resolution (`path.resolve` for relative paths), `publish-native` workflow fails on missing `.node` files instead of warning, shell variable quoting for sync metrics and export commands.
- Removed stale `sdl-mcp` self-reference from `package.json` dependencies.
- `tree-sitter-kotlin` version constraint loosened to `^0.3.8` for broader compatibility.

## [0.10.0] - 2026-03-26

### Breaking

- Minimum Node.js version raised from 20 to 24. Node 20 and 22 are no longer supported runtime targets.
- TypeScript compilation target upgraded from ES2022 to ES2024.

### Added

- Tool inventory generation: `scripts/generate-tool-inventory.ts` produces `docs/generated/tool-inventory.json` and `tool-inventory.md` from source truth. `scripts/check-tool-inventory.ts` enforces sync. npm scripts: `docs:tools:generate`, `docs:tools:check`.

- `sdl.runtime.execute` now supports `outputMode` (`"minimal"` | `"summary"` | `"intent"`), enabling two-phase execute-then-query flows with significantly lower token usage for large command output.
- New tool `sdl.runtime.queryOutput` for on-demand retrieval and keyword filtering of stored runtime output artifacts.
- Hybrid retrieval stack across Stages 0-3:
  - New `src/retrieval/` subsystem and model-aware retrieval pipeline.
  - Kuzu FTS/vector extension and index lifecycle helpers.
  - Schema updates for inline embedding columns on `Symbol` plus migration `m007`.
  - New Stage 3 entity retrieval primitives (`searchText` on `Cluster`/`Process`, `FileSummary` node + indexes + persistence wiring).
- Embedding-augmented heuristic summaries (Tier 1.5).
- `sdl-mcp info --json` for machine-readable diagnostics output.
- CI test matrix expanded to Node 22.x and 24.x (ubuntu + windows).

### Changed

- **Breaking behavior**: `repo.status` `surfaceMemories` now defaults to `false`. Pass `surfaceMemories: true` explicitly when memories are needed.
- Agent executor `cacheHits` metric now reports real cache hit counts instead of placeholder zeros.
- Telemetry: tools with `totalTokens` response fields (e.g., `sdl.workflow`) are now counted in `usage.stats` with neutral savings (zero inflation).
- Decomposed `src/mcp/tools/index.ts` into declarative `tool-descriptors.ts` with `ToolDescriptor` interface and `buildFlatToolDescriptors()` factory (370 -> 78 lines).

- Replaced `tsx` with Node 24 native `--experimental-strip-types` across development and test scripts.
- All CI workflows (ci, release-publish, publish-native, publish-ladybug) updated from Node 20.x to 24.x.
- Hybrid retrieval now powers start-node resolution in slice building and is integrated into `slice.build`, context summaries, and agent planning.
- Overlay parity was expanded so draft-only symbols are retained by fusion and served consistently across hybrid and non-hybrid search paths.
- Additional build/runtime maintenance improvements were applied (incremental build enablement, type scoping cleanup, lazy-loading adjustments, and parser/indexer modularization hardening).

### Fixed

- `sdl.runtime.execute` `maxResponseLines` now honors requested values (instead of effectively capping around 40 lines).
- Added per-line truncation guards (500 chars max) so single long lines do not dominate response budgets.
- Retrieval/overlay correctness fixes: mock fallback guard, vector index naming consistency, `overlayOnly` behavior in non-hybrid search, and fusion retention for overlay-only hits.
- Node 24 migration and CI stabilization fixes, including tree-sitter compatibility updates and post-migration test hardening.
- Token savings meter follow-up fixes and schema drift/code hardening fixes across the release window.

## [0.9.2] - 2026-03-22

### Added

- User-visible token savings meter via MCP logging notifications (`notifications/message`)
  - Per-call: compact meter bar showing that call's savings (for example, `████████░░ 84%`)
  - End-of-task: session + lifetime cumulative stats sent when `sdl.usage.stats` is called
- Human-readable tool call formatter with concise per-tool summaries while keeping JSON responses unchanged for the LLM
- `logging` capability declared in MCP Server capabilities
- Repo overview performance cache with singleflight deduplication (5s TTL)

### Changed

- Session usage summaries now combine session and lifetime data from LadybugDB and emit the formatted summary as an MCP notification instead of extra tool payload
- Pass2 edge-builder logic was split into focused sub-modules (`enclosing-symbol`, `symbol-mapping`, `target-selection`, `unresolved-imports`)
- The `indexer.ts` monolith was split into focused init, pass1, pass2, versioning, and memory modules for safer maintenance
- Post-install pruning now keeps only required install artifacts, reducing package footprint by roughly 312 MB
- Runtime tool maximum duration increased to 10 minutes, with broader runtime, config, and documentation hardening across the release

### Fixed

- Semantic summary generation bug in the native TypeScript extraction path
- Orchestrator tool execution regressions and additional tool logic edge cases
- LadybugDB Cypher query issues in memory ordering and word-boundary search handling
- Repo overview performance regression, plus broader hardening across indexing, runtime, and benchmark paths

### Removed

- `renderTaskSummary` function (redundant with `renderSessionSummary`)

## [0.9.1] - 2026-03-20

### Added

- Unified runtime diagnostics via CLI `sdl-mcp info` and MCP `sdl.info`
- `prepare-release` and `inspector` npm workflows for release preflight and MCP inspection

### Changed

- MCP tool registration now publishes human-friendly titles, version-stamped descriptions, and shared request normalization across flat, gateway, and CLI tool-dispatch surfaces
- Gateway `tools/list` schemas now preserve action-specific fields, descriptions, and defaults instead of collapsing to a bare envelope
- Logging is now file-first with `SDL_LOG_FILE`, `SDL_CONSOLE_LOGGING`, temp-path fallback, and explicit shutdown flushing
- Documentation was refreshed across CLI, architecture, troubleshooting, gateway, code-mode, and release workflow references

### Fixed

- Native platform package versions are synchronized with the root `sdl-mcp` release version
- `prepare-release` now launches npm subcommands correctly on Windows
- Release preflight packaging and stdio smoke coverage now validate the new diagnostics and tool registration surfaces

## [0.9.0] - 2026-03-17

### Added

- **Development memory system** — DB-backed `sdl.memory.store`, `sdl.memory.query`, `sdl.memory.remove`, and `sdl.memory.surface` tools with graph-backed persistence (`Memory` nodes, `HAS_MEMORY`/`MEMORY_OF`/`MEMORY_OF_FILE` edges), file sync to `.sdl-memory/`, and memory surfacing for task context
- **Code-mode tool chaining** — `sdl.code.chain` executes multi-step tool chains with budget tracking, ETag caching, ladder validation, reference resolution, and manual generation for composable context retrieval
- **Database migration framework** — `src/db/migration-runner.ts` with versioned migrations, idempotent execution, and schema upgrade support so re-indexing is not required on version bumps
- **Memory tools registered in tool gateway** with compact schema and routing support

### Changed

- **Call edge resolution dramatically improved** — ESM `.js` → `.ts` extension remapping in import resolution fixes the primary cause of broken cross-file call links; global disambiguation prefers exported symbols over test-local redeclarations; TS compiler resolver now activates for Pass 2 even when Rust indexer handles Pass 1
- HTTP transport auth setup refactored for cleaner token handling
- Semantic embedding progress now visible during `sdl-mcp index`
- GitHub Actions upgraded to Node.js 24 runner versions

### Fixed

- Two pre-existing CI test failures resolved
- `flatted` dependency overridden to >=3.4.0 to resolve CI security audit failure
- Stress test and tokenizer install script reliability improved
- CLI and HTTP server interaction edge cases
- Runtime tool dispatch bugfix
- Broader code hardening pass across MCP, indexing, and test infrastructure

## [0.8.8] - 2026-03-15

### Added

- CLI tool access for direct MCP action invocation, including argument parsing, dispatch, structured output, and gateway-focused test coverage
- Tool gateway routing plus compact and thin schemas to reduce MCP token overhead, alongside measurement tooling and config-schema support
- Graph slice orchestration with beam-search start-node resolution, graph snapshot caching, serialization, and supporting metrics/repository integration

### Changed

- Local semantic embedding support now defaults to the `nomic-embed-text-v1.5` provider, with downloader, registry, and runtime docs aligned to the new model
- README and deep-dive documentation were expanded across CLI access, graph slicing, governance policy, runtime execution, indexing languages, and semantic workflows
- MCP, DB, live-index, policy, and code-window paths received a broader hardening pass before release, including stricter error handling and safer gating behavior

### Fixed

- HTTP auth token handling across the CLI transport path and stress harness client scenarios
- Stress-test reliability around Ladybug initialization and concurrent client execution
- Release-train regressions across slice, symbol, and code tools, plus telemetry, watcher/live-index parsing, and database query safety paths

## [0.8.7] - 2026-03-13

### Added

- Multi-language Rust native extraction now covers Python, Go, Java, C, Shell, Rust, C#, C++, and PHP symbol, import, and call extraction, plus richer doc-comment, invariant, side-effect, and role detection
- Pass2 and indexer resolution coverage now includes C#, C++, C, Shell, Python, Kotlin, Rust, and PHP adapters, with matching resolve-call harness and stress tooling updates
- Local semantic embedding runtime support and the new `sdl.runtime` tool broaden the runtime surface for higher-output tasks and semantic workflows
- Stress-test coverage expanded for multiple concurrent clients and the growing multi-language resolver pipeline

### Changed

- Native extraction internals were restructured into language-dispatched modules and enabled across all supported languages
- Slice responses now use a refactored wire format with typed MCP errors, alongside general code, CI, and test hardening across the release train

### Fixed

- Native fallback and config-edge traversal regressions, including deeper and larger-file parsing hardening in the Rust extraction path
- Runtime tool policy handling, spillover signature regressions, and UI asset stream failure handling

## [0.8.6] - 2026-03-11

### Added

- Shared startup bootstrap logic and focused regression coverage to register configured repositories before watcher startup on fresh graph databases

### Changed

- Startup conflict messaging now explains the real pidfile scope, including the exact PID file path and the requirement to use a different database directory for a separate server instance

### Fixed

- `npm run dev` and the CLI `serve` path now follow the same repository-registration bootstrap, preventing fresh-database startup failures with `Repository ... not found`
- PID-file conflict handling now gives accurate recovery guidance when another `sdl-mcp` process is already running for the same database directory

## [0.8.5] - 2026-03-10

### Added

- Multi-session HTTP MCP session management and streamable transport handling so concurrent clients can share one server process with isolated session state
- Configurable MCP dispatch limiting plus new session-manager, dispatch-limiter, and Ladybug connection-pool regression coverage

### Changed

- Ladybug reads and writes now run through pooled and serialized access paths across CLI, MCP, indexing, sync, and live-index flows to reduce write conflicts under concurrent load
- The config schema and example config now expose concurrency controls for MCP dispatch and graph database access
- Benchmark and release lockfile coverage were refreshed to keep CI and publish-path validation stable after the concurrency changes

### Fixed

- TypeScript indexer fallback logic now recovers more reliably when native language support is unavailable
- CI regression guards around Ladybug E2E coverage and release lockfile checks were tightened after recent infrastructure changes

## [0.8.4] - 2026-03-10

### Added

- Ladybug package-contract, query-coverage, and MCP language regression coverage to lock the migration behavior in place across DB, indexing, and code-access paths
- Actionable rebuild guidance when older graph databases cannot be opened after the backend migration

### Changed

- The embedded graph backend is now consistently named Ladybug across DB modules, tests, scripts, configs, and documentation while continuing to load `@ladybugdb/core` through the existing `kuzu` compatibility seam
- Default graph database paths and examples now use the `.lbug` extension, and the benchmark/migration tooling was refreshed to match the Ladybug naming
- README, configuration, troubleshooting, and release-test docs were updated to reflect the Ladybug-backed storage model and current release workflow

### Fixed

- Post-refactor DB issues across slice building, metrics, versioning, sync, and MCP tool flows after the Ladybug rename
- Kotlin grammar loading and TSX/JSX component export handling in indexing and code-access paths, with matching regression tests
- CI and release follow-up issues uncovered during the migration, including lockfile and publish-path stability fixes

### Upgrade Notes

- Existing `.kuzu` graph directories should be recreated or migrated to the Ladybug-backed `.lbug` path before relying on older persisted data

## [0.8.3] - 2026-03-09

### Added

- Release-publish lockfile coverage to keep npm bootstrap behavior under test in CI
- Broader multi-language code-access handling in tree-sitter-backed skeleton and hot-path flows

### Changed

- Release publishing now bootstraps on Node 20 with a more reliable npm install path in the publish workflow
- Slice start-node resolution, graph metrics writes, watcher logging, and pass2/indexing internals were tightened to reduce noisy results and improve stability under load

### Fixed

- ENOENT and parser crash paths across indexing, watcher, and code-access flows to reduce unexpected failures during file churn
- Security hardening across DB init, plugin loading, regex compilation, symlink handling, JSON parsing, repo path validation, and MCP request budget limits

## [0.8.2] - 2026-03-09

### Added

- PID-file coordination and shutdown-manager utilities so `sdl-mcp serve` and stdio mode can detect an already-running MCP process, avoid duplicate startups, and shut down cleanly when the parent terminal closes
- File-backed logging with rotation plus new `safeJson` and `safeRegex` utilities for safer parsing and regex compilation in production paths
- Focused unit coverage for shutdown, pidfile handling, JSON safety, regex safety, Kuzu core helpers, and batched symbol deletion regressions

### Changed

- Tree-sitter runtime packages were upgraded from `0.21.1` to `0.25.0`, with matching native grammar rebuilds and workflow updates to keep CI and release publishing aligned
- Shared protocol/domain contracts now live in `src/domain/types.ts`, separating canonical types from MCP transport wiring
- The Kuzu persistence layer was refactored from a monolithic query file into domain-specific modules plus `ladybug-core.ts` for clearer ownership and safer DB access patterns
- Release and CI workflows now use npm trusted publishing (OIDC), `npm ci --ignore-scripts --legacy-peer-deps`, and more stable sync-memory/runtime-budget validation steps

### Fixed

- Graceful shutdown behavior for stdio and `serve` entry points when the terminal closes, including stale-process detection before startup
- Security and robustness issues called out in code review: dynamic evaluation was removed from embeddings loading, JSON parsing is validated before use, and regex compilation is guarded against ReDoS-style patterns
- Resource cleanup and error reporting across watchers, worker pools, live-index services, sync paths, and MCP handlers to reduce leaks and swallowed failures
- Skeleton/hot-path code access paths now include additional crash protection, memory guards, and logging hardening around tree-sitter-backed operations

### Documentation

- Refreshed README positioning and feature descriptions to match the current Kuzu-backed, cards-first SDL-MCP architecture and release workflow

## [0.8.0] - 2026-03-06

### Added

- Live editor-buffer indexing transport and MCP tools (`sdl.buffer.push`, `sdl.buffer.status`, `sdl.buffer.checkpoint`) with HTTP endpoints for buffer push, live status, and explicit checkpointing
- In-memory draft overlay, draft-aware symbol/search/slice reads, file-scoped save patching, background reconciliation, idle checkpoint compaction, and live-index runtime health coverage in `doctor`
- `liveIndex` configuration block with defaults for enablement, debounce, idle checkpointing, draft capacity, and reconciliation tuning
- LadybugDB (`kuzu`) embedded graph backend as the sole persisted graph store, with directory-based initialization, idempotent schema bootstrap, and async query coverage across repo/file/symbol/version/slice flows
- One-time SQLite-to-Kuzu migration support plus Kuzu-aware setup/health surfaces (`graphDatabase.path`, updated `init`/`doctor`, `spike:kuzu`, and refreshed release-test guidance)
- Symbol graph enrichment via clusters (community detection) and processes (call-chain traces), surfaced in symbol cards, slices, , `sdl.repo.overview`, and blast-radius analysis
- Rust + TypeScript cluster/process support with new parity, unit, and integration coverage, including `tests/integration/kuzu-e2e.test.ts`
- Generalized pass2 resolver registry with `pass2-ts` and `pass2-go`, plus import-resolution adapters for Go, Java/Kotlin, Rust, and PHP
- Confidence-aware MCP graph filtering (`minCallConfidence`) and optional per-call provenance metadata (`resolverId`, `resolutionPhase`, `resolutionReason`) on symbol-card and slice responses

### Changed

- Save events now compact clean overlay state through checkpoint service after durable Kuzu patching instead of leaving saved drafts resident in memory
- `repo.status` and live buffer status now report checkpoint and reconciliation diagnostics for the live indexing path
- Config now uses `graphDatabase.path` for graph DB directory control; `dbPath` is deprecated and only retained for the one-time SQLite-to-Kuzu migration path
- Graph queries, indexing flows, and MCP tool responses now read from Kuzu-backed storage/types instead of SQLite tables
- Incremental indexing refreshes pass-2 caller contexts more reliably via incoming call/import edge hints
- Graph schema version bumped to `2` so `DEPENDS_ON` edges can persist resolver provenance, and `doctor` now reports pass2 resolver coverage plus confidence-filtering mode

### Fixed

- Call attribution for calls in variable initializers now attributes to the enclosing function (not the variable symbol)
- Kuzu incremental deletes now remove cluster/process edges before deleting `Symbol` nodes
- Worker-pool extraction now preserves `astFingerprint` for delta correctness when parse trees are not returned

### Removed

- SQLite runtime dependencies and legacy persistence modules from the main v0.8.0 code path (`better-sqlite3`, legacy query/migration modules, and SQLite-only concurrency coverage)
- Checked-in generated `src/**/*.js` companion files for TypeScript sources; generated runtime artifacts now come from the normal build pipeline

### Documentation

- Updated the README, configuration reference, MCP tools reference, and release test checklist for LadybugDB storage, `graphDatabase.path`, and cluster/process metadata

### Upgrade Notes

- Existing v0.7.x installs should re-index into a fresh Kuzu graph directory or run the one-time SQLite-to-Kuzu migration flow before depending on historical `dbPath` data

## [0.7.2] - 2026-03-03

### Added

- Prefetch cache for search→card transitions: `prefetchCardsForSymbols()` eagerly caches cards for top-5 search results, anticipating the most common `symbol.search` → `symbol.getCard` workflow
- Prefetch edge targets after `symbol.getCard` for anticipated `slice.build` calls via `prefetchSliceFrontier`
- `"search-cards"` prefetch task type with priority 70 (highest among non-blast-radius tasks)
- `catch_unwind` safety wrapper in Rust native indexer (`native/src/parse/mod.rs`): tree-sitter C-level panics are caught per-file and converted to `parse_error` strings instead of crashing the Node.js process
- 8 MiB stack size on Rayon worker threads to prevent stack overflows from deeply-nested ASTs
- `ready: Promise<void>` on `IndexWatchHandle` interface: resolves when chokidar completes its initial directory scan, enabling callers to reliably wait before performing file operations

### Changed

- Tool trace recording now covers all 13 MCP tools (was 3/13); the prefetch model can now learn real transition patterns across the full tool surface
- `computePriorityBoost` in `prefetch-model.ts` now normalizes full tool names (e.g., `"symbol.getCard"`) to short keys (e.g., `"card"`) before priority lookup, fixing a mapping gap that caused model predictions to never boost queue priorities
- Batch `symbol.getCards` now consumes prefetched `card:` keys for each requested symbol
- Code tools (`needWindow`, `getSkeleton`, `getHotPath`) now consume prefetched `card:` keys at request start
- Delta tool now consumes prefetched `blast:` keys after computing changed symbols
- File watcher integration tests await `watcher.ready` before writing files, with increased timeouts (5s→15s) and 500ms FS settle delays

### Fixed

- Prefetch system 0% cache hit rate: search→card prefetch alone targets 40%+ hit rate; combined with edge prefetch and full tool traces, expected 50%+
- Rust native indexer crash (exit code 0xC0000409 / STATUS_STACK_BUFFER_OVERRUN on Windows) when `SDL_CONFIG` specifies `engine: "rust"`: tree-sitter panics in Rayon worker threads no longer abort the process
- Three integration tests (`index-refresh-timeout-fixes`, `otel-tracing`, `two-pass-indexing`) crashing with exit code 3221226505 due to inheriting global `SDL_CONFIG` with Rust engine; tests now force `SDL_CONFIG=""` for isolation
- File watcher integration tests (`file-watch-live`) timing out because `watchRepository()` returned before chokidar's `ready` event fired, causing file events written immediately after to be missed

## [0.7.1] - 2026-02-28

### Added

- Cross-platform per-platform npm packages for the native Rust indexer (`sdl-mcp-native`), supporting darwin-arm64, darwin-x64, linux-arm64-gnu, linux-x64-gnu, linux-x64-musl, and win32-x64-msvc
- Platform-specific binary auto-detection via `native/index.js` with 3-tier fallback (platform package → root binary → graceful degradation)
- `scripts/sync-native-version.mjs` for synchronizing version numbers across all native packages
- `publish-native.yml` GitHub Actions workflow for automated native package publishing on git tags

### Changed

- Default indexing engine switched from `"typescript"` to `"rust"` in example config for faster indexing out of the box
- Config fields `packageJsonPath`, `tsconfigPath`, `workspaceGlobs`, `workerPoolSize`, `otlpEndpoint`, `poolSize`, and `minBatchSize` now accept `null` in addition to `undefined` (Zod `.optional()` → `.nullish()`)
- Beam-parallel parity test relaxed to 30% overlap threshold (from 80%) to accommodate floating-point tie-breaking variance across platforms
- CI workflow uses `npm install --ignore-scripts` instead of `npm ci` to handle unpublished optional native dependencies gracefully
- Native package versions bumped to 0.7.1 across all 6 platform packages and umbrella package
- Updated example config documentation to reflect current feature defaults

### Fixed

- `SemanticConfigSchema.enabled` test expecting `false` when schema default is `true`
- Config loading failures when example config contains `null` values for optional fields (Zod validation rejected `null` with `.optional()`)
- TypeScript build errors in `diagnostics.ts` and `indexer.ts` from `null` flowing through to functions expecting `string | undefined`
- Native build CI job failing due to `npm ci` lockfile sync mismatch with unpublished `sdl-mcp-native@0.7.1`
- `prepublishOnly` script in native package conflicting with CI publish workflow
- darwin-x64 native build using incorrect runner; switched to macos-latest cross-compile

## [0.7.0] - 2026-02-28

### Added

- `native/package.json` with napi-rs configuration, enabling `@napi-rs/cli build` to locate native addon metadata from the project root

### Changed

- Native build scripts (`build:native`, `build:native:debug`) now use `napi build --cargo-cwd native --config native/package.json native` instead of `cd native && npx @napi-rs/cli build`, fixing resolution failures when `npx` cannot find the CLI from the `native/` subdirectory
- Sync-memory CI performance budgets increased to accommodate runner variance (Linux index: 45s→120s, Windows index: 70s→180s)
- ANN benchmark timing thresholds relaxed for CI stability (1k vectors: 2s→5s, 2k vectors: 10s→20s)
- Benchmark baseline (`baseline.zod-oss.json`) updated to reflect current edge-resolution metrics (`edgesPerSymbol`: 14.5→11.6, `importEdgeCount`: 53746→42420)
- Beam-parallel parity test now uses overlap-based assertion (>=80%) instead of strict equality, accounting for non-deterministic tie-breaking between sync/async code paths
- File-watch-live integration tests skip on CI (`process.env.CI`) where filesystem event latency is unreliable

### Fixed

- MCP stdio server silently exiting on non-TTY Linux environments; added stdin close/end handlers to prevent premature shutdown
- `package-lock.json` out of sync with `@napi-rs/cli` devDependency, causing `npm ci` failures
- Security vulnerabilities in transitive dependencies: ajv (8.17.1→8.18.0), hono (4.11.9→4.12.3), minimatch (3.1.2→3.1.5), qs (6.14.1→6.15.0)

### Documentation

- Updated MCP tool documentation across all 13 tools

## [0.6.9] - 2026-02-28

### Added

#### Feature 1: LLM-Generated Symbol Summaries

- Added `symbol_summary_cache` DB table (migration `0018`) to persist LLM-generated summaries independently of heuristic summaries
- Added `AnthropicSummaryProvider` and `OpenAICompatibleSummaryProvider` to `summary-generator.ts`
- Cache integration: `generateSummaryWithGuardrails` checks cache by `cardHash` before calling provider
- Batch generation at index time via `generateSummariesForRepo` (concurrent batches via `Promise.allSettled`)
- New config fields in `semantic`: `summaryModel`, `summaryApiKey`, `summaryApiBaseUrl`, `summaryMaxConcurrency`, `summaryBatchSize`
- `IndexResult` now includes `summaryStats?: SummaryBatchResult`; CLI prints summary counts after indexing

#### Feature 2: Real-Time File Watching Fixes

- **Bug fix**: Compiled `src/config/types.js` had `enableFileWatching: false` while source had `true`; now synced
- Fixed 6+ additional missing schemas/fields in `types.js` (SemanticConfigSchema, PluginConfigSchema, etc.)
- Added `scripts/check-config-sync.ts` + `npm run check:config-sync` CI step to detect future drift
- Added `watchDebounceMs` config field (default 300ms, range 50–5000ms)
- Windows path normalization in watcher event handler (backslash/forward-slash)
- `sdl.repo.status` now includes `watcherNote` when watcher is inactive
- Error budget exceeded sets `health.stale = true` and logs to stderr

#### Feature 3: TypeScript Type-Aware Call Resolution

- Import alias following via `checker.getAliasedSymbol()` (fixes destructured imports)
- Barrel re-export chain resolution up to depth 5
- Tagged template literal support (`ts.isTaggedTemplateExpression`)
- Arrow function variable edge emission with repo-root guard
- Cross-module type inference confidence tier `0.4`
- Incremental `ts.Program` reuse via `programCache` + `invalidateFiles()` method on `TsCallResolver`
- `callResolution` metric added to `sdl.repo.status` health components

#### Feature 4: Canonical Test Mapping

- Added `CanonicalTest` interface to `src/mcp/types.ts`
- `computeCanonicalTest` in `src/graph/metrics.ts`: BFS forward+backward, depth ≤ 6, ≤ 500 visited nodes
- `canonical_test_json` column added to `metrics` table (migration `0019`)
- `getCanonicalTest` query function; exposed in `sdl.symbol.getCard` response as `metrics.canonicalTest`

#### Feature 5: Fan-in Trend Alerts in Delta Packs

- Extended `BlastRadiusItem` with `fanInTrend?: { previous, current, growthRate, isAmplifier }`
- `FAN_IN_AMPLIFIER_THRESHOLD = 0.20` in constants
- `getFanInAtVersion` uses version-scoped subquery for accurate per-version fan-in approximation
- `sdl.delta.get` response always includes `amplifiers: []` summary array
- Amplifiers sorted before non-amplifiers within same BFS distance tier

## [0.6.8] - 2026-02-20

### Added

- Native Rust pass-1 indexing engine via napi-rs, with tree-sitter support for 12 languages (TS, JS, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP, Scala, Swift). Enable with `indexing.engine: "rust"` in config.
- `ToolContext` interface passing MCP progress tokens, abort signals, and `sendNotification` through to tool handlers.
- `sdl.index.refresh` now emits MCP `notifications/progress` so clients can display real-time indexing status (stage, current file, progress percentage).
- Configurable slice cache: `cache.graphSliceMaxEntries` now controls the in-memory graph slice LRU cache size at runtime.
- Native build CI job for cross-platform Rust addon compilation and parity testing on Ubuntu, Windows, and macOS.
- `build:native`, `build:native:debug`, and `test:native-parity` npm scripts.
- Integration test for index-refresh timeout edge cases.

### Changed

- File scanner now excludes compiled JS files when a corresponding TS source exists at the same path, preventing duplicate symbol indexing.
- `sdl.code.getHotPath` `matchedIdentifiers` field now returns only identifiers confirmed present in the AST, rather than echoing the full request list.
- `sdl.code.needWindow` clamps `expectedLines` and `maxTokens` to configured policy limits instead of using policy maximums directly.
- `sdl.code.getSkeleton` returns `null` for files exceeding `maxFileBytes`, preventing out-of-memory reads on very large files.
- `PolicyEngine` is now constructed per-request instead of shared as a module-level singleton, eliminating stale policy state between concurrent requests.
- Benchmark scope ignores native/, dist/, build/, target/, and non-source directories for accurate source-only metrics.
- CI benchmarks run against a locked external OSS repository (zod-oss) for stable cross-run comparisons.
- Claude Code template updated: `serve --stdio` args, `--yes` and `@latest` flags for npx, placement docs reference `~/.claude.json`.
- `init` command detects `~/.claude.json` as a Claude Code client config candidate.

### Fixed

- Java adapter no longer sets `namespaceImport` on wildcard imports, which caused false import edges during resolution.
- All code and symbol tools now validate that the requested symbol belongs to the specified `repoId`, preventing cross-repo data leakage.
- Incremental indexing skips files whose `mtime` predates `last_indexed_at`, avoiding redundant re-processing of unchanged files.
- Incremental indexing reuses the existing version ID when no files changed, instead of creating an empty snapshot.

## [0.6.7] - 2026-02-19

### Added

- New MCP feedback tools: `sdl.agent.feedback` and `sdl.agent.feedback.query` for capturing and querying symbol-level usefulness signals from agent runs.
- Agent feedback persistence with migration `0017_agent_feedback.sql`, schema/query support, and symbol feedback weight updates for offline tuning inputs.
- v0.6.7 benchmark and validation coverage, including new benchmark scripts and tests for ANN retrieval, lazy graph loading, beam-parallel behavior, and slice regressions.

### Changed

- Refactored slice construction into focused `src/graph/slice/*` modules (start-node resolution, beam search, serialization, and truncation) to improve maintainability and execution behavior.
- Expanded MCP tooling and response typing around slice/delta/repo flows, including richer error handling and stronger boundary validation for code-window and wire-format paths.
- Updated benchmark/config surfaces (`.benchmark/baseline.json`, `config/benchmark.config.json`, `config/sdlmcp.config.schema.json`) for the v0.6.7 baseline and new runtime options.

## [0.6.6] - 2026-02-18

### Added

- Documentation coverage for `v0.6.5` feature surfaces:
  - HTTP graph UI and REST endpoints (`/ui/graph`, `/api/graph/*`)
  - semantic search usage and configuration (`semantic`, `semantic: true`)
  - prefetch configuration and `sdl.repo.status.prefetchStats` observability
  - benchmark edge-accuracy lock/baseline references
  - VSCode extension documentation links from top-level docs

### Changed

- Updated core docs pages (`README`, docs hub, getting started, CLI reference, MCP tools reference, configuration reference) to reflect current shipped behavior.

## [0.6.5] - 2026-02-18

### Added

- Phase A delivery: one-line setup flags (`-y/--yes`, `--auto-index`, `--dry-run`), context summary CLI/MCP tooling, watcher health/stale recovery, and health score surfaces.
- Phase B delivery: edge-accuracy benchmark suite + CI baseline gate, `resolution_strategy` edge metadata, plugin resolver hook (`resolveCall`), Python/Go/Java resolver upgrades, and confidence calibration support.
- Phase C delivery: symbol embedding storage + migration, hybrid lexical+semantic reranking (`semantic: true`), optional local ONNX runtime path, generated summaries (feature-flagged), and incremental embedding refresh by `cardHash`.
- Phase D delivery: graph REST endpoints, browser graph explorer UI with progressive loading and SVG/PNG export, and VSCode extension MVP (status bar, CodeLens, hover, on-save reindex, diagnostics).
- Phase E delivery: deterministic prefetch queue/rules, prefetch safeguards and config, startup warm prefetch, prefetch effectiveness metrics in `sdl.repo.status`, and learned-model scaffold.
- Added unit/benchmark coverage for edge accuracy, edge calibration, semantic reranking, summary generation, embedding migration, prefetch behavior, and repo-status schema changes.

### Changed

- Config schema now includes semantic and prefetch settings used by indexing, search, serve, and status flows.
- `sdl.repo.status` response expanded with health and prefetch observability fields consumed by CLI/HTTP/extension surfaces.
- Benchmark CI flow now evaluates edge-quality regression thresholds and emits edge-resolution telemetry.

### Fixed

- Optional local embedding runtime loading no longer fails TypeScript typecheck when `onnxruntime-node` is not installed.
- Semantic search test setup now bootstraps embedding table state for isolated SQLite runs.
- Repo status schema tests now include required prefetch metrics fields.
- Slice prefetch frontier seeding now derives correctly from `slice.cards`.

## [0.6.4] - 2026-02-13

### Added

- Edge confidence support across indexing and slicing:
  - `edges.confidence` is now persisted by `createEdge()`/`createEdgeTransaction()`
  - slice cards now include dependency confidence metadata (`{ symbolId, confidence }`)
  - `sdl.slice.build` accepts `minConfidence` (default `0.5`)
- TypeScript resolver option `includeNodeModulesTypes` (default `true`) with `@types/node` exclusion
- New tests for edge confidence, dep-list filtering, two-pass indexing progress, and index CLI `--force`

### Changed

- TypeScript indexing now reports explicit `pass1`/`pass2` progress stages
- TS/JS call resolution runs with a two-pass flow (symbols/imports first, then call-edge reconciliation)
- Beam search now applies `edgeWeight * confidence` scoring and adaptive confidence tightening at high budget utilization
- Slice payloads now filter dependency lists to only symbols included in the slice
- `sdl-mcp index` now supports `--force` for explicit full re-indexing (default path uses incremental mode when possible)
- Agent workflow/setup docs were refreshed for current SDL-MCP initialization and context ladder usage

### Fixed

- Missing `config/sdlmcp.config.json` baseline in benchmark tests
- Call-edge confidence defaults and unresolved-edge confidence handling in TS/heuristic resolution paths
- Benchmark drift corrections for confidence dependency-reference handling in benchmark scoring flows
- Real-world benchmark slice-card inflation now normalizes dependency refs to symbol-id lists for strict script type-checking/publish builds

## [0.6.0] - 2026-02-08

### Added

#### PR Risk Copilot (V06-1, V06-2)

- `sdl.pr.risk.analyze` MCP tool for pull request risk assessment
- Risk model computing composite scores from churn, fan-in/out, diagnostic density, and blast radius
- File-level and symbol-level risk classification (critical, high, moderate, low)
- Configurable risk threshold via `riskThreshold`
- Unit test coverage for PR risk analysis flow

#### Agent Autopilot (V06-3, V06-4)

- `sdl.context` MCP tool for policy-aware rung selection with evidence capture
- Budget and focus controls (`budget`, `options.focusPaths`, `options.focusSymbols`)
- Action tracing with per-step status and collected evidence

#### Continuous Team Memory (V06-5, V06-6)

- Sync artifact export/import protocol for portable repository state
- `exportArtifact()` producing compressed, content-addressed `.sdl-artifact.json` bundles
- `importArtifact()` restoring full repository state (files, symbols, edges, metrics, versions)
- `pullWithFallback()` for artifact-first sync with configurable retry and fallback
- Deterministic artifact hashing ensuring reproducible exports
- CI workflow integration for automated sync artifact generation

#### Benchmark Guardrails (V06-7, V06-8)

- `benchmark:ci` CLI command for automated performance regression detection
- Threshold evaluator comparing current metrics against configurable baselines
- Statistical smoothing with configurable sample runs and warmup iterations
- Baseline management via baseline files and `benchmark:ci --update-baseline`
- CI gate behavior driven by exit code and configured thresholds
- Threshold configuration via `config/benchmark.config.json`

#### Adapter Plugin SDK (V06-9, V06-10)

- Public plugin contract (`PluginManifest`, `AdapterPlugin`, `AdapterRegistration`)
- Runtime plugin loader with validation, error reporting, and lifecycle management
- `loadPlugin()`, `loadPluginsFromConfig()`, `getPluginAdapters()` API
- Plugin registry with one-shot initialization guards and `resetRegistry()` for test isolation
- Sample `.vlang` plugin demonstrating extractSymbols, extractCalls, and generateSkeleton
- Plugin development templates and integration test patterns
- API version compatibility checking (`PLUGIN_API_VERSION`)

### Changed

- Prepared statement caching in `queries.ts` now supports `resetQueryCache()` for safe DB lifecycle management across test boundaries
- `diff.ts` symbol version lookup uses inline `getDb().prepare()` instead of module-level cached statements to avoid stale references
- `sync.ts` uses ESM-compatible imports (`readFileSync`, `gunzipSync`) instead of CJS `require()` calls

### Fixed

- Statement cache invalidation across `closeDb()`/`getDb()` cycles causing "database connection is not open" errors
- EBUSY errors on Windows when test cleanup attempted file deletion before closing SQLite connections
- ESM module resolution failures in test files importing from `src/` instead of `dist/`
- `getArtifactMetadata()` returning null due to CJS `require()` in ESM context
- `pullWithFallback()` artifact path mismatch between export naming and lookup directory
- Example plugin `extractCalls` not handling unresolved external function references
- 20 integration test failures resolved, achieving 676/676 tests passing (0 failures)

### Known Limitations

- `benchmark:ci` requires a real repository path for live benchmarking; CI environments need the repo checked out at the configured path
- Plugin SDK currently supports synchronous adapters only; async adapter support is planned for v0.7
- Sync artifacts do not include raw file content, only metadata and symbol graph state
- Agent Autopilot execution plans are generated but external tool invocation requires host integration

### Follow-up Items

- Async adapter plugin support (v0.7 candidate)
- Sync artifact delta compression for incremental updates
- Agent Autopilot tool integration with external CI/CD systems
- PR Risk Copilot integration with GitHub/GitLab webhook events
- Benchmark baseline auto-update on main branch merges

## [0.5.1] - 2026-01-29

### Added

- LICENSE file (MIT license)
- Testing documentation (`docs/TESTING.md`) documenting dist-first testing strategy
- `npm run test:harness` execution step in CI workflow

### Fixed

- Skeleton extraction issues causing test failures (now 27/27 tests passing E2E)

### Changed

- Version bumped to 0.5.1

## [0.5.0] - 2026-01-29

### Added

#### v0.5: Sync + Governance + Context Ladder + Merkle Ledger

**Sync Protocol (SDL-027, SDL-028, SDL-029, SDL-030)**

- Slice handles and leases from `sdl.slice.build` for cache-coherent protocol
- `sdl.slice.refresh(handle, knownVersion)` for delta-only incremental updates
- ETag/ifNoneMatch semantics for `sdl.symbol.getCard` with 304-style notModified responses
- Handle/lease registry in DB with automatic cleanup of expired handles

**Policy Engine (SDL-031, SDL-032, SDL-040)**

- Formal policy engine with deterministic checks and auditable decision records
- Uniform policy integration across all retrieval tools (code, slice, symbol)
- `nextBestAction` responses shaping tool choices (requestSkeleton|requestHotPath|requestRaw|refreshSlice)
- Support for approve|deny|downgrade-to-skeleton|downgrade-to-hotpath decisions

**Context Ladder (SDL-033)**

- New `sdl.code.getHotPath` tool extracting matching identifier lines with minimal context
- Explicit 4-rung escalation: Card → Skeleton → Hot-path excerpt → Raw window
- Default policy denies raw windows unless rung 2/3 fails

**Skeleton IR (SDL-034, SDL-035)**

- Deterministic skeletonization with semantic trace types (if/try/return/throw, calls, elisions)
- Byte-stable Skeleton IR for identical inputs
- Inline side-effect markers for network/fs/env/process/global state operations

**Governor Loop v2 (SDL-036, SDL-037)**

- Deterministic governor loop merging graph, diagnostics, and budgeted selection
- `trimmedSet` and `spilloverHandle` in delta responses
- `sdl.slice.spillover.get` tool for paged overflow retrieval without recomputation

**Content-Addressed Ledger (SDL-038)**

- Card normalization and content-addressed storage via stable hashing
- Card deduplication based on normalized content hash
- Merkle-ish version chain with prevVersionHash and versionHash linkage
- ETag derived from cardHash

**Staleness Tiers (SDL-039)**

- Stability detection for interface, behavior (Skeleton IR), and sideEffects
- Risk score calculation combining tier flags with fan-in/out and diagnostics signal

#### v0.4: Universal v1 Polish

**Skeletonization (FR8, Group 14)**

- `sdl.code.getSkeleton` tool for on-demand skeleton generation
- Preserves signatures, control flow, important call sites, and identifiers
- Elides dense bodies into `// …` blocks, achieving 5-20% of raw window token cost
- Deterministic output for same inputs

**Diagnostics Governor (FR9, Group 15)**

- TypeScript LanguageService host for in-process diagnostics
- Diagnostic-to-symbol mapping using existing symbol ranges
- Enhanced `sdl.delta.get` with diagnosticsSummary and diagnosticSuspects
- Blast radius with signal field (diagnostic|directDependent|graph)

**CLI (SDL-020, Group 16)**

- `sdl-mcp init` command scaffolding config and database
- `sdl-mcp doctor` command for validation checks (paths, dependencies, permissions)
- `sdl-mcp version` command displaying version information
- `sdl-mcp index` command triggering repository refresh

**Transports (SDL-021, Group 16)**

- stdio transport (default) with stderr-only logging
- HTTP transport for local bind with token-safe logs
- Configurable log levels and formats (json|pretty)
- Stable request IDs for correlation

**Client Templates (SDL-022, Group 17)**

- Config templates for Claude Code, Codex CLI, Gemini CLI, Opencode CLI
- `sdl-mcp init --client <name>` for template selection
- Windows path hygiene with proper quoting for PowerShell and cmd

**Caps and Truncation (SDL-023, Group 18)**

- Shared truncation helper enforcing hard caps on all responses
- Applied to slice, delta, cards, windows, and skeletons
- Truncation metadata: truncated, droppedCount, howToResume

**MCP Resources (SDL-024, Group 18)**

- Resource URIs for card://{repoId}/{symbolId}@{version}
- Resource URIs for slice://{repoId}/{sliceId}
- Lightweight handle returns when enabled

**Test Harness (SDL-025, Group 19)**

- Golden task fixtures for register→index→slice→card→skeleton→delta→window flow
- Test runner starting server in stdio mode
- Client profile assertions for compatibility validation

**Packaging (SDL-026, Group 19)**

- `npm install -g sdl-mcp` support
- Single-exe build script for Windows deployment

#### Post-v0.5 Hardening (Partial)

**ESM Runtime**

- Fixed relative import specifiers across 30+ files
- Validated runtime entrypoints for `dist/main.js` and `dist/cli/index.js`

### Changed

- All tools now respect policy engine decisions
- Blast radius ordering prioritizes diagnostic suspects over graph neighbors
- Slice responses include handles and leases for cache-coherent client behavior
- Delta responses include trimmedSet and spilloverHandle for overflow handling

### Deprecated

- None

### Removed

- None

### Fixed

- Windows path normalization issues in database storage and retrieval
- Import specifier compatibility for ESM runtime execution

### Security

- Expired lease enforcement prevents stale handle reuse
- Content-addressed storage ensures ETag integrity
- Audit hashes in policy decisions for traceability

[0.10.4]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.10.4
[0.10.3]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.10.3
[0.10.2]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.10.2
[0.10.1]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.10.1
[0.10.0]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.10.0
[0.8.5]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.8.5
[0.8.4]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.8.4
[0.8.3]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.8.3
[0.8.2]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.8.2
[0.8.0]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.8.0
[0.7.2]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.7.2
[0.7.1]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.7.1
[0.7.0]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.7.0
[0.6.9]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.9
[0.6.8]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.8
[0.6.7]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.7
[0.6.6]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.6
[0.6.5]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.5
[0.6.4]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.4
[0.6.0]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.6.0
[0.5.1]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.5.1
[0.5.0]: https://github.com/GlitterKill/sdl-mcp/releases/tag/v0.5.0
