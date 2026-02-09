# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-02-08

### Added

#### PR Risk Copilot (V06-1, V06-2)

- `sdl.pr.riskAnalysis` MCP tool for pull request risk assessment
- Risk model computing composite scores from churn, fan-in/out, diagnostic density, and blast radius
- File-level and symbol-level risk classification (critical, high, moderate, low)
- Configurable risk thresholds and weighting via policy engine
- Suggested reviewers based on ownership and expertise signals
- Harness test coverage for risk analysis end-to-end flow

#### Agent Autopilot (V06-3, V06-4)

- `sdl.agent.autopilot` MCP tool for AI-assisted workflow orchestration
- Orchestration planner generating multi-step execution plans from natural language goals
- Policy-integrated execution flow with approval gates and rollback support
- Step-level status tracking (pending, running, completed, failed, skipped)
- Workflow test coverage for plan generation, execution, and error recovery

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
- Baseline management with `benchmark:baseline:save` and `benchmark:baseline:load`
- Fail policy (warn, fail, block) controlling CI gate behavior
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
- TEST documentation (TESTING.md) documenting dist-first testing strategy
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

[0.6.0]: https://github.com/your-org/sdl-mcp/releases/tag/v0.6.0
[0.5.1]: https://github.com/your-org/sdl-mcp/releases/tag/v0.5.1
[0.5.0]: https://github.com/your-org/sdl-mcp/releases/tag/v0.5.0
