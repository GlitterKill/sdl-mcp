# SDL-MCP Improvement Roadmap v2 (Recommendations 1,3,4,5,6,7,8,9,10)

> **For Agents:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the highest-leverage SDL-MCP improvements in a sequence that maximizes adoption and context quality while controlling technical risk.

**Architecture:** The roadmap prioritizes foundations first (setup, workflow speed, edge quality), then layers on expensive intelligence features (semantic retrieval, predictive prefetch). Core MCP contracts stay stable while new capabilities are added as additive tools/commands and optional services. Product surface expansion (UI and IDE extension) is intentionally gated on backend quality and setup simplicity to avoid scaling weak internals.

**Tech Stack:** Node.js >=18, TypeScript 5.9+ (strict ESM), SQLite (`better-sqlite3`), tree-sitter (12 language grammars), TypeScript Compiler API, MCP SDK ^1.26.0, Zod, optional embeddings/vector backend, optional web UI stack, optional VSCode extension APIs.

---

## Baseline Snapshot (as of 2026-02-17, v0.6.4)

### Codebase Metrics

- Version: `0.6.4`
- Source files: `60+` TypeScript files (~13,000 lines)
- MCP tools: `13` implemented + `sdl.repo.overview`, `sdl.pr.risk.analyze`, `sdl.agent.orchestrate`
- CLI commands: `5` (init, doctor, index, serve, version) + export/import/pull
- Database migrations: `6`
- Tests: `676/676` passing (0 failures)

### Index Metrics (self-indexed)

- Indexed files: `287`
- Indexed symbols: `7,864`
- Total edges: `266,557`
- Call edges: `8,778` (with confidence metadata since v0.6.4)
- Import edges: `257,779`

### Already Implemented Capabilities (v0.6.x)

These features are **already shipped** and the roadmap must build on them, not re-invent them:

| Capability | Status | Version |
|---|---|---|
| CLI init with `--client`, `--languages`, `--force` | Shipped | v0.4 |
| Doctor command (6 checks) | Shipped | v0.4 |
| Watch mode (chokidar + native fallback, debouncing) | Shipped | v0.4 |
| Repo overview tool (stats/directories/full levels) | Shipped | v0.5 |
| Sync artifact export/import/pull | Shipped | v0.6.0 |
| PR Risk Copilot (`sdl.pr.risk.analyze`) | Shipped | v0.6.0 |
| Agent Autopilot (`sdl.agent.orchestrate`) | Shipped | v0.6.0 |
| Benchmark guardrails (`benchmark:ci`) | Shipped | v0.6.0 |
| Plugin/Adapter SDK (sync adapters, 12 languages) | Shipped | v0.6.0 |
| Edge confidence + two-pass TS indexing | Shipped | v0.6.4 |
| Confidence-weighted beam search in slicing | Shipped | v0.6.4 |
| `--force` flag for full re-index | Shipped | v0.6.4 |

### What Remains Lexical-Only

- Symbol search uses lexical matching with heuristic NL ranking
- No embeddings-based semantic retrieval
- No generated summaries

## Scope and Assumptions

- Input recommendations: `1, 3, 4, 5, 6, 7, 8, 9, 10` (Recommendation `#2` was not supplied; see note in Appendix A).
- This is a roadmap only; no implementation work is included.
- Time windows are target ranges adjustable by team capacity.
- Windows-first development: all work must pass on Windows (path handling, native modules, EBUSY guards).
- MCP protocol contract stability: existing tool schemas must not break. New capabilities are additive.

## Prioritization Rules

1. Remove adoption friction before adding advanced intelligence.
2. Improve graph accuracy before building UX surfaces that depend on graph trust.
3. Keep high-cost ML/embedding features behind clear success gates and feature flags.
4. Treat telemetry and benchmarking as hard requirements for phase progression.
5. **New:** Leverage existing v0.6 infrastructure (benchmarks, plugin SDK, sync protocol) rather than building parallel systems.

## Phase Plan Overview

| Phase | Weeks | Recommendations | Theme |
|---|---|---|---|
| A | 1-3 | #7, #10, #9, #8 | Adoption and developer experience |
| B | 4-8 | #5 | Graph accuracy (non-TS languages) |
| C | 9-14 | #1 | Intelligence layer |
| D | 15-20 | #4, #6 | Product surfaces |
| E | 21-26 | #3 | Predictive intelligence |

---

## Detailed Roadmap by Recommendation

### Recommendation 7: One-Line Setup

**Priority:** P0
**Target Window:** Phase A (Weeks 1-2)
**Version Target:** v0.7.0

**Outcome**
- `npx sdl-mcp init .` runs fully non-interactive and produces a ready-to-use setup in under 60 seconds.

**Current State**
- `init` command exists with interactive language prompts, config generation, `--client` templates, and rollback on failure.
- Requires 4 separate commands to reach a working state: `init` -> `doctor` -> `index` -> `serve`.

**What Changes**

- M1: Add `--yes` / `-y` flag for non-interactive mode. Default to all detected languages (scan file extensions in target directory), skip prompts. Auto-detect repo name from directory or `package.json`.
- M2: Add `--auto-index` flag (or make it default with `--yes`). After config creation, run incremental index inline, display progress bar, then run `doctor` checks automatically.
- M3: Emit copy-paste-ready agent config block to stdout at the end (detect installed clients via config file locations). Add `--dry-run` flag to preview config without writing.
- M4: Add `npx` shim so `npx sdl-mcp init .` works without global install (verify `bin` field + `files` array covers all needed assets).

**Success Metrics**
- `npx sdl-mcp init . -y` completes in `< 90 seconds` on a 300-file TS repo.
- Setup step count: `1` command for non-interactive, `2` for interactive.
- Doctor pass rate after init `>= 95%` on repos with `package.json`.
- Zero prompts in non-interactive mode.

**Go/No-Go Gate**
- Tested on 3+ repo types (TS monorepo, Python project, mixed-language). Docs updated with quickstart.

**Risks**
- Auto-detection may pick wrong languages in polyglot repos. Mitigation: log detected languages, allow override via `--languages`.

---

### Recommendation 10: Copy-Paste Context Summary

**Priority:** P0
**Target Window:** Phase A (Weeks 2-3)
**Version Target:** v0.7.0

**Outcome**
- New `sdl-mcp summary` CLI command producing a token-bounded, LLM-ready context block for a symbol, file, or task query.

**Current State**
- `export` command exists but produces sync artifacts (full graph state), not human/LLM-readable summaries.
- `sdl.repo.overview` produces repo-level stats but not task-scoped summaries.
- Individual card/slice outputs are available but require MCP client orchestration to assemble.

**What Changes**

- M1: Define summary output schema:
  ```
  # Context: <query>
  ## Key Symbols (N symbols, ~T tokens)
  <card summaries: name, kind, signature, 1-line summary>
  ## Dependency Graph
  <compact adjacency list>
  ## Risk Areas
  <symbols with high fan-in, recent churn, or diagnostic signals>
  ## Files Touched
  <file list with symbol counts>
  ```
- M2: Implement `sdl-mcp summary <query>` with options:
  - `--budget <tokens>` (default: 2000, presets: `--short` 500, `--medium` 2000, `--long` 5000)
  - `--format markdown|json|clipboard` (default: markdown)
  - `--scope symbol|file|task` (auto-detected from query)
  - `--output <file>` (default: stdout)
- M3: Add `sdl.context.summary` MCP tool exposing the same logic for agent consumption.
- M4: Determinism tests: same query + same index version = byte-identical output. Token bound tests: output never exceeds `budget * 1.05`.

**Success Metrics**
- p95 generation time `< 500ms` for cached index (no re-index needed).
- Output token count within `5%` of requested budget.
- Deterministic output for identical inputs.

**Go/No-Go Gate**
- Manual eval on 10 task queries shows summaries are actionable without additional context in 8/10 cases.

**Risks**
- Query ambiguity (e.g., "auth" matches 50 symbols). Mitigation: use slice scoring to rank, truncate to budget, report truncation metadata.

---

### Recommendation 9: Auto-Sync Watch Mode

**Priority:** P0 (Polish/Defaulting)
**Target Window:** Phase A (Weeks 2-3)
**Version Target:** v0.7.0

**Outcome**
- Watch mode is reliable enough to enable by default when running `serve`.

**Current State**
- Full chokidar-based watcher with native `fs.watch` fallback.
- Debouncing, stability threshold, error accumulation (max 100 errors).
- `index --watch` and `serve --watch` both work.
- Config option: `indexing.enableFileWatching`.

**What Changes**

- M1: Add watcher health telemetry:
  - Track: files watched, events received, events processed, errors, last successful re-index timestamp, queue depth.
  - Expose via `sdl.repo.status` (new `watcherHealth` field) and `sdl-mcp doctor`.
- M2: Add stale-index detection: if the watcher is running but the last successful re-index was `> 60s` ago despite file changes, log a warning and attempt recovery (restart watcher).
- M3: Default `enableFileWatching: true` in generated configs from `init`. Add `serve --no-watch` to opt out.
- M4: Document common failure modes (antivirus locks on Windows, inotify limits on Linux, network drives) in troubleshooting section.

**Success Metrics**
- Watcher uptime `>= 99%` over 8-hour sessions (measured via telemetry).
- Re-index latency p95 `< 5s` after file save (on repos `< 500 files`).
- Error recovery success `>= 90%` (auto-restart on failure).
- Zero undetected stale-index states lasting `> 2 minutes`.

**Go/No-Go Gate**
- Stability metrics hold for 2 release cycles before promoting to default-on in documentation.

**Risks**
- Windows EBUSY errors during rapid saves. Mitigation: existing retry logic in indexer; add exponential backoff if not present.
- High CPU on large repos with many transient files. Mitigation: respect ignore patterns, add `maxWatchedFiles` config cap.

---

### Recommendation 8: Health Score Badge

**Priority:** P1
**Target Window:** Phase A (Week 3)
**Version Target:** v0.7.0

**Outcome**
- Composite health score (0-100) reflecting index quality, freshness, and coverage.

**Current State**
- `doctor` command runs 6 boolean checks (pass/fail).
- `sdl.repo.status` returns basic stats (file count, symbol count, version).
- No composite score or badge endpoint.

**What Changes**

- M1: Define health score formula:
  ```
  score = w1 * freshness + w2 * coverage + w3 * errorRate + w4 * edgeQuality

  freshness  = max(0, 1 - (minutesSinceLastIndex / 1440))  [0-1, decays over 24h]
  coverage   = indexedFiles / totalEligibleFiles              [0-1]
  errorRate  = 1 - (indexErrors / totalFiles)                 [0-1]
  edgeQuality = resolvedCallEdges / totalCallEdges            [0-1]

  Weights: w1=0.25, w2=0.35, w3=0.20, w4=0.20
  ```
- M2: Add `sdl-mcp health` CLI command outputting score + component breakdown. Add `--json` flag for CI consumption. Add `--badge` flag outputting shields.io-compatible JSON.
- M3: Add `healthScore` field to `sdl.repo.status` response.
- M4: Add score thresholds for badge color: green `>= 80`, yellow `>= 60`, red `< 60`.

**Success Metrics**
- Score correlates with real indexing failures (validate against 5+ failure scenarios).
- Component weights tuned so no single factor dominates unfairly.

**Go/No-Go Gate**
- Score validated against known-good and known-broken repos before shipping badge endpoint.

**Risks**
- Gaming via trivial repos (100% score on empty repo). Mitigation: require minimum file/symbol count for non-zero score. Show "N/A" badge below threshold.

---

### Recommendation 5: Smart Call Edge Inference

**Priority:** P0
**Target Window:** Phase B (Weeks 4-8)
**Version Target:** v0.8.0

**Outcome**
- Raise call-edge precision and recall across all 12 supported languages, with measurable improvement on non-TS languages where coverage is weakest.

**Current State**
- Two-pass TS/JS indexing with TypeScript compiler API resolution (shipped v0.6.4).
- Edge confidence persisted and used in beam search scoring (shipped v0.6.4).
- `minConfidence` parameter on `sdl.slice.build` (shipped v0.6.4).
- Non-TS languages (Python, Go, Java, Rust, etc.) rely on tree-sitter AST heuristics with lower resolution accuracy.
- Plugin SDK supports custom adapters that can override call extraction.

**What Changes**

- M1: **Establish baseline.** Create a precision/recall benchmark suite:
  - Select 3 benchmark repos per language tier: Tier 1 (TS/JS), Tier 2 (Python, Go, Java), Tier 3 (Rust, C#, Kotlin, C/C++, PHP, Bash).
  - Manually annotate ground-truth call edges for 50 functions per repo.
  - Measure current precision, recall, and F1 per language.
  - Integrate into `benchmark:ci` pipeline.
- M2: **Improve Tier 2 resolvers.**
  - Python: Add import-path-based call resolution (resolve `from foo import bar; bar()` to the correct symbol).
  - Go: Add package-qualified call resolution (resolve `pkg.Function()` via import path).
  - Java: Add class-qualified method resolution using import statements.
  - Target: F1 improvement `>= 15%` on Tier 2 languages.
- M3: **Confidence calibration.** Tune confidence scores so they correlate with actual resolution correctness:
  - Analyze false positives/negatives from M1 benchmark.
  - Adjust confidence thresholds per resolution strategy (exact match vs. heuristic vs. unresolved).
  - Add `edgeResolutionStrategy` metadata to edges (exact, heuristic, unresolved).
- M4: **Regression suite.** Lock M1 benchmark as a regression gate:
  - `benchmark:ci` fails if F1 drops below established baseline for any language tier.
  - Add specific test cases for: dynamic dispatch, method chaining, callbacks/closures, re-exports.

**Success Metrics**
- Tier 1 (TS/JS): F1 `>= 0.85` (maintain current level).
- Tier 2 (Python, Go, Java): F1 improves by `>= 15%` from baseline.
- Tier 3: F1 documented, no regression.
- Slice relevance improves on benchmark task suite (fewer false-positive symbols in slices).
- Confidence calibration: symbols with confidence `>= 0.8` are correct `>= 90%` of the time.

**Go/No-Go Gate**
- Phase C starts only when Tier 2 F1 targets are met and regression suite is green.

**Risks**
- Language-specific heuristics are fragile. Mitigation: each improvement is behind the existing confidence system; low-confidence edges are naturally de-prioritized.
- Benchmark annotation is labor-intensive. Mitigation: start with 50 functions per repo, expand incrementally. Consider semi-automated annotation using TS compiler as reference for TS repos.

---

### Recommendation 1: AI-Native Semantic Layer

**Priority:** P1
**Target Window:** Phase C (Weeks 9-14)
**Version Target:** v0.9.0

**Outcome**
- Hybrid semantic retrieval: lexical candidate generation + embedding-based reranking. Optional LLM-generated summaries for symbol cards.

**Current State**
- Lexical search with heuristic NL ranking.
- No embeddings infrastructure.
- No external API dependencies.

**What Changes**

- M1: **Design embedding storage.**
  - New migration (`0007_embeddings.sql`): `symbol_embeddings` table with `symbolId`, `embeddingVector` (BLOB), `model`, `version`, `createdAt`.
  - Embedding lifecycle: generate on index, invalidate on symbol change (use existing cardHash for change detection).
  - Storage format: quantized float16 vectors to minimize SQLite storage.
  - Configurable embedding provider (local vs. API) via config.
- M2: **Hybrid retrieval pipeline.**
  - Stage 1: Lexical candidate generation (existing search, top-100).
  - Stage 2: Embedding similarity reranking (cosine similarity against query embedding).
  - Stage 3: Final score = `alpha * lexicalScore + (1 - alpha) * semanticScore` (alpha configurable, default 0.6).
  - Fallback: if embedding provider unavailable, return lexical-only results (no degradation).
  - New tool parameter: `sdl.symbol.search({ ..., semantic: true })`.
- M3: **Local embedding option.**
  - Support `onnxruntime-node` with a small model (e.g., `all-MiniLM-L6-v2`) for offline/air-gapped use.
  - Lazy loading: ONNX runtime loaded only when semantic search is enabled.
  - Add as optional dependency (not required for core functionality).
- M4: **Generated summaries (optional).**
  - LLM-generated 1-2 line summaries for symbol cards, cached in DB.
  - Configurable provider (OpenAI, Anthropic, local) via config.
  - Rate limiting and cost tracking.
  - Quality safeguard: compare generated summary against existing heuristic summary; flag divergence.
  - Feature flag: `semantic.generateSummaries: false` by default.

**Success Metrics**
- Semantic search MRR (Mean Reciprocal Rank) improves `>= 20%` over lexical baseline on benchmark queries.
- p95 search latency `< 200ms` for lexical+rerank (excluding cold embedding generation).
- Embedding generation cost `< $0.01` per 1000 symbols (API mode).
- Local embedding mode works fully offline with `< 500MB` model size.
- Zero degradation when embedding provider is unavailable.

**Go/No-Go Gate**
- Feature flag stays on `opt-in` until MRR improvement is validated on 3+ repos.
- Generated summaries remain behind separate flag until hallucination rate `< 5%`.

**Risks**
- External API dependency introduces latency and cost. Mitigation: local model option, aggressive caching, async embedding generation.
- Embedding model drift on updates. Mitigation: version-track model in embeddings table, re-embed on model change.
- SQLite BLOB storage for vectors may not scale. Mitigation: monitor DB size; plan migration to sqlite-vec or external vector store if needed.
- Windows compatibility for ONNX runtime. Mitigation: test on Windows early; fall back to API-only if native binding fails.

---

### Recommendation 4: Interactive Graph Visualization

**Priority:** P2
**Target Window:** Phase D (Weeks 15-18)
**Version Target:** v0.10.0

**Outcome**
- Browser-based graph explorer for slices, dependencies, and blast radius, served from the SDL-MCP HTTP transport.

**Current State**
- HTTP transport exists for development use.
- Slice, delta, and overview data is available via MCP tools.
- No web UI.

**What Changes**

- M1: **Define visualization API.**
  - Add `/api/graph/:repoId` REST endpoints (reuse existing HTTP transport).
  - Endpoints: `/slice/:handle`, `/symbol/:symbolId/neighborhood`, `/blast-radius/:fromVersion/:toVersion`.
  - Response format: D3-compatible node/link JSON.
  - CORS configuration for local development.
- M2: **Build MVP graph explorer.**
  - Tech: vanilla HTML + D3.js (or vis.js) bundled as static assets. No framework dependency.
  - Features: force-directed layout, node color by symbol kind, edge color by type (call/import/config), node size by fan-in.
  - Interactions: click-to-expand, search/filter, zoom/pan, hover for card summary.
  - Risk overlay: highlight blast-radius symbols in red/orange.
  - Serve at `http://localhost:<port>/ui/graph`.
- M3: **Performance controls.**
  - Progressive loading: start with entry symbols, expand on demand.
  - Max visible nodes cap (default 200, configurable).
  - Collapse clusters for directories with `> 10` symbols.
  - Render budget: skip animation for `> 100` nodes.

**Success Metrics**
- Initial render `< 2s` for slices with `<= 50` symbols.
- Usable (responsive interactions) up to `200` visible nodes.
- Bundle size `< 500KB` (no heavy framework).

**Go/No-Go Gate**
- User testing with 3+ developers confirms blast-radius visualization reduces time-to-understand impact.

**Risks**
- Large graphs overwhelm the browser. Mitigation: progressive loading + node cap.
- Maintenance burden of a web UI. Mitigation: keep it minimal (static assets, no build step, no framework).

---

### Recommendation 6: IDE Extension (VSCode/Cursor)

**Priority:** P2
**Target Window:** Phase D (Weeks 17-20)
**Version Target:** v0.10.0

**Outcome**
- VSCode extension providing inline SDL insights: impact scores, dependency counts, and blast radius on hover/gutter.

**Current State**
- No IDE integration.
- MCP tools provide all needed data.
- HTTP transport available for local communication.

**What Changes**

- M1: **Extension MVP.**
  - New `sdl-mcp-vscode/` directory in repo (or separate repo).
  - Features:
    - Status bar item showing index health score.
    - CodeLens on function/class declarations showing fan-in/fan-out counts.
    - Hover provider showing symbol card summary.
    - Command palette: "SDL: Show Blast Radius", "SDL: Refresh Index".
  - Communication: HTTP transport to local `sdl-mcp serve` instance.
  - Auto-detect running server (scan common ports or read config).
- M2: **On-save hooks.**
  - Trigger incremental re-index on file save (if watcher not running).
  - Debounce to avoid thrashing (500ms delay).
  - Opt-in via extension settings (default: off).
  - CPU/memory guardrails: skip if indexing already in progress.
- M3: **Settings and diagnostics.**
  - Extension settings: server URL, auto-connect, CodeLens toggle, on-save toggle.
  - Diagnostic panel showing server connection status, last index time, symbol count.
  - Workspace-level `.vscode/settings.json` integration.

**Success Metrics**
- Extension activates in `< 1s` after opening a project with running SDL-MCP server.
- CodeLens render latency `< 100ms` per visible declaration.
- CPU overhead from extension `< 5%` during editing.
- Installation size `< 5MB`.

**Go/No-Go Gate**
- Internal dogfooding for 2 weeks before marketplace publish.

**Risks**
- Server not running = extension is useless. Mitigation: clear "server not found" status, offer to start server.
- CodeLens on every declaration may be noisy. Mitigation: configurable threshold (only show for fan-in `> N`).
- Cursor compatibility not guaranteed. Mitigation: test on Cursor early; use standard VSCode API only.

---

### Recommendation 3: Predictive Context Pre-Fetch

**Priority:** P3
**Target Window:** Phase E (Weeks 21-26)
**Version Target:** v0.11.0

**Outcome**
- Proactive context warming based on task patterns and historical usage, reducing perceived latency for common workflows.

**Current State**
- No prefetch capability.
- Agent Autopilot (`sdl.agent.orchestrate`) tracks action traces, providing raw data for pattern analysis.
- Slice handles and leases exist, enabling cache reuse.

**What Changes**

- M1: **Deterministic prefetch heuristics (no ML).**
  - Rule 1: When a slice is built, pre-warm cards for symbols 1-hop beyond the slice boundary (frontier symbols).
  - Rule 2: When a file is opened/saved, pre-build a slice centered on that file's exported symbols.
  - Rule 3: When `sdl.delta.get` is called, pre-compute blast radius for changed symbols.
  - Implementation: background task queue with priority ordering and cancellation.
  - Budget cap: prefetch consumes at most `20%` of configured token budget.
- M2: **Measure prefetch effectiveness.**
  - Track metrics: cache hit rate, wasted prefetch (computed but never requested), latency reduction.
  - Log prefetch decisions and outcomes for analysis.
  - Dashboard in `sdl.repo.status`: prefetch stats.
- M3: **Learned prediction model (conditional).**
  - Only proceed if M2 shows deterministic prefetch hit rate `>= 40%`.
  - Train lightweight model on action traces from `sdl.agent.orchestrate`: given task type + entry symbols, predict next tools + symbols.
  - Model: simple Markov chain or n-gram over tool sequences (no heavy ML framework).
  - Retrain on each index refresh using accumulated traces.
- M4: **Safeguards.**
  - Privacy: never prefetch symbols from repos not in the current session.
  - Resource: cancel prefetch when system is under load (CPU `> 80%`).
  - Staleness: invalidate prefetch cache on index version change.
  - Config: `prefetch.enabled: false` by default. `prefetch.maxBudgetPercent: 20`.

**Success Metrics**
- Deterministic prefetch cache hit rate `>= 40%` on benchmark task suites.
- p50 context retrieval latency reduction `>= 30%` for cache hits.
- Wasted prefetch (computed but unused) `< 50%` of total prefetch.
- Zero observable latency regression for non-prefetch operations.

**Go/No-Go Gate**
- ML model rollout blocked unless deterministic prefetch shows sustained gains over 2 release cycles.

**Risks**
- Prefetch wastes resources on wrong predictions. Mitigation: budget cap, cancellation, wasted-prefetch tracking.
- Background tasks interfere with foreground operations. Mitigation: low-priority task queue, yield on contention.

---

## Cross-Cutting Workstreams (All Phases)

### Telemetry (All Phases)

- **Phase A:** Add setup-time tracking (init-to-first-successful-query). Add watcher health metrics. Add summary generation metrics.
- **Phase B:** Add per-language edge resolution metrics (precision, recall, F1). Add confidence calibration metrics.
- **Phase C:** Add semantic search quality metrics (MRR, latency, embedding generation cost). Add summary quality metrics.
- **Phase D:** Add UI interaction metrics (render time, click depth, session length). Add extension activation and usage metrics.
- **Phase E:** Add prefetch effectiveness metrics (hit rate, waste rate, latency reduction).

### Benchmarking (All Phases)

- Lock benchmark repos at Phase A start: minimum 3 repos covering TS, Python, and a Tier 3 language.
- Extend `benchmark:ci` to include new metrics as each phase ships.
- Record benchmark deltas in release notes for each minor version.
- Benchmark results must be reproducible (hermetic builds, pinned dependencies).

### Release Safety (All Phases)

- Feature flags for: semantic search (#1), graph UI (#4), IDE extension (#6), prefetch (#3).
- Staged rollout: opt-in -> default-off -> default-on (each requiring 1 release cycle of stability).
- Breaking change policy: no MCP tool schema changes without a deprecation period.

### Documentation (All Phases)

- Update README quickstart section after Phase A.
- Update CLAUDE.md context ladder protocol after Phases B and C.
- Update AGENTS.md with new tools/commands after each phase.
- Maintain CHANGELOG.md per Keep a Changelog format.

### Testing (All Phases)

- All new features require unit tests with `>= 80%` branch coverage.
- Integration tests via `test:harness` for new MCP tools.
- Golden tests for deterministic outputs (summaries, skeletons, health scores).
- Windows CI: all tests must pass on Windows (existing CI already enforces this).

### Database Migration Strategy

- New migrations follow existing pattern (`migrations/0007_*.sql`, `0008_*.sql`, etc.).
- Migrations must be backward-compatible: new columns should have defaults.
- Schema changes require a migration test (apply to empty DB + apply to v0.6.4 DB).

---

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| ML/embedding features increase cost and unpredictability | High | Medium | Hybrid fallback, strict budgets, opt-in flags, local model option |
| UI/extension ships before backend quality is sufficient | Medium | Low | Explicit quality gates after Phase B/C |
| Watcher defaults create noisy or unstable behavior | Medium | Medium | Staged default rollout, telemetry monitoring, error budget |
| Embedding storage bloats SQLite database | Medium | Medium | Quantized vectors, monitor DB size, plan vector store migration path |
| Windows native module compatibility (ONNX, tree-sitter) | High | Low | Test on Windows first, fall back to API-only |
| Non-TS language resolvers are fragile and hard to test | Medium | High | Confidence system de-prioritizes low-quality edges, regression suite |
| Scope creep in UI/extension phases | Medium | High | Strict MVP scope, feature-flag everything, defer "nice-to-have" |
| Maintaining backward compatibility across 5 phases | Medium | Medium | No breaking tool schema changes, deprecation periods, feature flags |

---

## Release Cadence

| Phase | Target Version | Release Content |
|---|---|---|
| A | v0.7.0 | One-line setup, summary command, watch polish, health score |
| B | v0.8.0 | Edge inference improvements, per-language benchmarks |
| C | v0.9.0 | Semantic search, optional embeddings, generated summaries |
| D | v0.10.0 | Graph UI, VSCode extension |
| E | v0.11.0 | Predictive prefetch |

- End of each phase: ship one minor release with release notes and benchmark deltas.
- After Phase B and Phase C: explicit go/no-go review before moving forward.
- Patch releases (v0.X.Y) for bug fixes between phases.

---

## Final Prioritized Sequence

1. `#7` One-Line Setup (P0, Phase A)
2. `#10` Copy-Paste Context Summary (P0, Phase A)
3. `#9` Auto-Sync Watch Mode polish (P0, Phase A)
4. `#8` Health Score Badge (P1, Phase A)
5. `#5` Smart Call Edge Inference (P0, Phase B)
6. `#1` AI-Native Semantic Layer (P1, Phase C)
7. `#4` Interactive Graph Visualization (P2, Phase D)
8. `#6` IDE Extension (P2, Phase D)
9. `#3` Predictive Context Pre-Fetch (P3, Phase E)

---

## Appendix A: Missing Recommendation #2

Recommendation #2 was not supplied in the input. The gap in numbering is acknowledged. If #2 is provided later, it should be evaluated for insertion based on:
- Does it have dependencies on existing phases?
- Does it block or accelerate other recommendations?
- What is its priority relative to the existing sequence?

## Appendix B: v0.6 Follow-Up Items Not Covered

The v0.6.0 CHANGELOG lists these follow-up items. This roadmap does not explicitly address them, but they should be considered for integration:

| Item | Potential Phase | Notes |
|---|---|---|
| Async adapter plugin support | Phase B | Natural fit alongside edge inference improvements |
| Sync artifact delta compression | Phase A or B | Reduces artifact size for large repos |
| Agent Autopilot external tool integration | Phase D | Aligns with IDE extension work |
| PR Risk webhook integration (GitHub/GitLab) | Phase D | Aligns with IDE/CI integration |
| Benchmark baseline auto-update on main merge | Phase A | Low-effort CI improvement |

## Appendix C: Optimization Opportunities

These are additional improvements identified during review that could be folded into existing phases:

1. **Phase A - Init auto-detection:** Detect `.gitignore` patterns and merge with default ignore list to avoid indexing build artifacts.
2. **Phase A - Summary caching:** Cache summary outputs keyed by `(query, indexVersion)` to avoid recomputation.
3. **Phase B - Plugin-contributed resolvers:** Allow adapter plugins to contribute language-specific call resolvers, not just symbol extractors. Extend `LanguageAdapter` interface with optional `resolveCall()` method.
4. **Phase C - Incremental embedding updates:** Only re-embed symbols whose `cardHash` changed, not the entire index.
5. **Phase D - Graph export:** Allow exporting graph visualization as SVG/PNG for documentation and PR descriptions.
6. **Phase E - Prefetch warming on `serve` start:** Pre-compute overview and top-N symbol cards on server startup for instant first query.
