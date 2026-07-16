# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Persisted graph integrity gate**: Full and incremental indexing now derive deterministic symbol digests from authoritative in-memory rows before persistence, then stream the final active LadybugDB graph in stable keyset order after shadow activation and semantic refresh. `DerivedState` records `unknown`, `verifying`, `verified`, or `failed`; `sdl.repo.status` withholds health until the digest is verified for the latest version and directs migrated or failed repositories to a full refresh. Verified-state publication uses compare-and-set so concurrent mutations win. Durable live-index patches atomically invalidate the previous digest, and sync import/pull invalidates before its first graph write, so watcher, checkpoint, file-write, and same-version artifact mutations cannot leave stale health marked verified.

### Fixed

- **Provider-first shadow FTS handoff**: Finalized shadow activation now rebuilds and verifies the configured critical Symbol FTS index after reopening the swapped database. Missing or unavailable required FTS state fails the handoff and restores the previous active database instead of reporting a degraded shadow as activated.
- **Forced-semantic context recall**: `sdl.context` calls with `options.semantic: true` now retain bounded lexical coverage, balance inferred-path hints against retrieval ranking, keep up to 20 precise cards, and surface deterministic same-file outlines with a bounded first-file dependency sample. The unchanged 26-case benchmark now enforces `>=85%` expected-symbol recall, `<=10%` configured noise, and zero failures; omitted/false semantic modes and other tools are unchanged.
- sdl.context: explicit focusPaths now scope hybrid retrieval instead of disabling it; precise mode enforces explicit focus paths strictly (empty result when nothing matches); inferred paths keep soft treatment; combined focusPaths/focusSymbols use intersection semantics; path-affinity ranking replaces the buried structural focus bonus; partial rung failures no longer mark evidence-bearing responses unsuccessful.

## [0.12.4] - 2026-07-14

### Added

- **Temporary Windows OpenSSL runtime for LadybugDB FTS**: Windows x64 installs now include the SDL-owned `@sdl-mcp/ladybug-openssl-win32-x64@3.5.7-sdl.2` optional package with corrected signer provenance, SBOM, license, and hash-pinned `libcrypto-3-x64.dll` / `libssl-3-x64.dll` runtime files for LadybugDB 0.18.1 FTS. The incorrect `.1` provenance boundary is retired and rejected.
- **Ladybug storage migration gate**: added a checksum-pinned v40 fixture that verifies LadybugDB 0.18.1 can migrate/checkpoint existing non-derived memory, feedback, usage, and audit rows.

### Changed

- **LadybugDB core upgrade**: the `kuzu` alias now resolves to the official `@ladybugdb/core@0.18.1` package. SDL still does not rebuild or republish LadybugDB itself.
- **Native package patch release**: `sdl-mcp-native` and its platform packages are released as `0.12.4` so registry installs expose the Windows `preloadWindowsLibrary` / `releaseWindowsLibrary` shim required by the runtime gate.

### Fixed

- **file.write/search.edit live-index crash**: Windows Symbol FTS provisioning now preloads the verified OpenSSL runtime by absolute package path before `LOAD EXTENSION fts`, allowing `patchSavedFile()` to mutate active Symbol FTS rows directly without the 0.16.1 drop/rebuild workaround.

## [0.12.3] - 2026-07-11

### Added

- **SDL Galaxy graph viewer**: first-class 3D code-graph viewer served by the HTTP transport at `/ui/viewer` (three.js, no bundler, no CDN; vendored assets under `/ui/vendor/`). Includes universe/cluster/symbol LOD, live activity overlay over the observability SSE stream (`/api/observability/stream?types=graph`), search/impact/community/edge lenses, inspector panel, declarative skin packs (zips in `<configDir>/skins`, served raw and unpacked client-side with hard caps), and ambient mode with idle-drift and FPS caps.
- **Read-only viewer REST facade** under `/api/graph/*` (bearer-gated): universe, clusters, layout (`lod=cluster|symbol`), edges, search, symbol card, impact (delta + blast radius), skins listing/serving, and recent graph events. Also available on the `--dashboard-port` loopback surface.
- **Deterministic 3D layout engine** in TypeScript and Rust with byte-identical parity (`npm run test:layout-parity`), seeded PRNG (mulberry32/fnv1a32), cached artifacts under `<configDir>/viewer-layout-cache`, and incremental warm-start re-layout.
- **`viewer.*` config block**: `enabled`, `skinsDir`, `fps`, `ambient.*`, `layout.*` (engine auto/typescript/rust, iterations, cacheDir, maxSymbolsPerClusterExpand), `skins.*` caps.
- New dependencies `three` + `fflate` (exact-pinned, vendored at build time) and npm scripts `build:ui`, `typecheck:ui`, `test:layout-parity`, `check:skin-template-sync`.
- **External benchmark framework**: reproducible external benchmark runs with canonical manifests, isolated databases, pinned SCIP inputs, and hardened preflight validation.
- **Safe glob patterns**: bounded bracket-class support with scan/watch parity coverage.
- **Embedding remediation**: safe remediation core and migrations for mismatched embedding destinations.

### Changed

- **Breaking (UI)**: the legacy SDL Graph Explorer at `/ui/graph` was removed; `/ui/graph` now issues a 308 redirect to `/ui/viewer`. Legacy `/api/graph/{repoId}/slice|neighborhood|blast-radius` endpoints remain (deprecated, now served from `src/viewer/legacy-graph.ts`).
- **Response efficiency**: trimmed redundant model response fields.

### Fixed

- **SDL Galaxy node-click crash**: symbol-edge expansion no longer evaluates LadybugDB's unsafe `value IN []` query shape when no edge-kind filter is selected, which previously terminated the Windows HTTP server with access violation `0xC0000005`. The endpoint now returns only intra-cluster edges that the expanded symbol layout can render.
- **Symbol HNSW rebuild crash hardening**: ported the FileSummary vector-rebuild hardening to the Symbol embedding lane after a silent native crash on 2026-07-08 (LadybugDB 0.16.x access violation during the second model's drop→write→create cycle tore the WAL). `refreshSymbolEmbeddings` now defers the rebuild until at least `SYMBOL_VECTOR_REBUILD_MIN_ROWS` (50) uncached rows accumulate (bootstrap full-scope runs always rebuild) and brackets each rebuild with WAL checkpoints (`symbol-vector-rebuild-pre-drop` / `-post-create`) so a crash can only tear that rebuild's writes. Also removes the pointless drop/create cycle on refreshes with zero uncached rows.
- **search.edit CRLF zero-match**: multi-line `query.literal` values with LF newlines silently matched nothing in CRLF files (`filesMatched: 0` with no skip reason). Literal queries are now compiled with EOL-tolerant newlines (`\r?\n`) in both the preview match counter and the replacePattern write path; replacement output already preserved the file's dominant EOL.
- **Viewer node visibility**: SDL Galaxy cluster/symbol meshes were rendered nearly black because instanced materials set `vertexColors: true` without a per-vertex color attribute, zeroing the shader color before per-instance colors applied. Instanced meshes now use plain bright materials driven by `setColorAt` plus an additive-blend halo shell for glow.
- **Viewer lens dropdown**: the Normal/Community/Impact/Edges selector only recolored one lens (community) into the colors it already had, so it appeared dead. Lens changes now restyle the whole scene: Normal (pale starlight), Community (palette per cluster), Impact (member-count/fan-in heat), Edges (dimmed nodes, emphasized edge lines); expanded symbol clusters follow the active lens.
- **Embedding and watcher maintenance**: deferred FileSummary embedding backlog work now accumulates safely, rollback failures are preserved, and Watchman teardown is hardened.
- **Benchmark and CLI safety**: benchmark child cleanup and drive-relative path validation are hardened; Claude Code setup now emits valid destinations.

_54 non-merge commits from 1 contributor_

## [0.12.2] - 2026-07-07

### Added

- **Answer-first context mode**: `sdl.context` now supports opt-in `options.answerFirst` for explain/debug tasks, returning a compact deterministic answer plus evidence when summary-provenance coverage is sufficient and falling back honestly when it is not.
- **Token-economy guidance**: Code Mode manual and action catalog entries now expose static response-cost estimates, digest-mode runtime guidance, answer-first usage, refs recovery, near-miss retries, and signal-density wording for agents.
- **Large file.read nudge**: non-indexed `sdl.file.read` adds a deterministic targeted-mode hint on large untargeted reads.

### Changed

- **Tool display deduplication**: user-facing text summaries no longer replay long `sdl.context` evidence summaries or generic `formattedSummary` payloads that already live in structured content.

_19 commits from 1 contributor_

## [0.12.1] - 2026-07-04

### Added

- **action.search as workflow step**: `sdl.workflow` steps can now call the action catalog directly (`fn: "actionSearch"` or `"action.search"`), matching the manual's wording. The workflow-facing action map routes the step to the meta handler; the manual documents the step under a new Discovery section.
- **Workflow wildcard projection**: `$N` references now support `[*]` array projection (e.g. `$0.results[*].symbolId` resolves to a `string[]`), covering the `symbolSearch -> symbolGetCard/sliceBuild` fan-out pattern without `dataMap` gymnastics.
- **Symbolic refactor ops**: Added graph-scoped `search.edit` `targeting:"rename"` and TypeScript/JavaScript `targeting:"signature"` previews that reuse the two-phase plan/apply pipeline.
- **Tree-sitter signature engine**: `targeting:"signature"` declaration and callsite transforms now walk the tree-sitter AST instead of a string scanner — call-shaped text inside string literals, comments, and template literals is no longer edited, and calls nested in template interpolations are.

### Changed

- **Response artifacts**: `search.edit` preview responses now default to `responseMode:"auto"`; pass `responseMode:"inline"` to force full inline previews. The default applies on every dispatch path (direct tool, gateway router, and `sdl.workflow`), not just raw handler calls.

### Fixed

- **response.get**: `maxTokens` is now enforced on the returned content (estimate-based shrink after slicing) instead of only seeding a 4-bytes-per-token pre-slice byte bound; `maxBytes` remains an exact byte cap. Schema description and manual updated to match.
- **runtime.execute**: `persistOutput: true` now writes a searchable marker artifact when a command completes with no captured stdout/stderr, instead of returning `artifactHandle: null`.
- **Manual drift**: the workflow manual now advertises `semanticEnrichmentStatus`'s existing `detail`/`limit` params and documents `[*]` reference projection.
- **PowerShell runtime false success**: `runtime.execute` with `runtime: "powershell"` reclassifies exit-code-0 runs as `failure` when stderr carries PowerShell error records (`FullyQualifiedErrorId`, `CategoryInfo`, npm.ps1 `$LASTEXITCODE` noise, etc.), with a corrective `runtimeHint`. Previously `-File` execution and wrapper shims could report success while the command actually failed.
- **Off-target sdl.context evidence for tool-QA prompts**: broad-mode seeding now detects prompts that name catalog actions, restricts entity search to symbol/fileSummary evidence (no cluster/process noise), and anchors the FTS query on the tool's handler/schema identifiers.
- **code.needWindow continuation over-promise**: the truncation `suggestedNextCall` now carries `granularity`, `maxTokens`, and `sliceContext` forward and no longer claims "all original params preserved" (response-shaping options must be re-added).
- **Node runtime ESM docs**: runtime docs, manual, and action catalog now state that Node `code` always runs as ESM (`node --input-type=module` / temp `.mjs`) — use `import`/`createRequire()`, never bare `require()`. The runtime deep-dive example shows an ESM snippet.

## [0.12.0] - 2026-07-01

### Added

- **Response projection**: Added handle-first response artifact projection with public metadata, hidden token usage accounting, and focused response retrieval coverage.
- **Summary generation**: Added embedding-oriented symbol summary text and defaulted the summary prose builder to mock-safe behavior.

### Changed

- **Code-mode workflows**: Improved workflow metadata, tool response envelopes, usage surfaces, and server instructions for indexed-source access.

### Fixed

- **SDLBench**: Injected repo IDs into agent prompts and instructions for fixture-scoped benchmark runs.
- **Release validation**: Updated response artifact metadata tests and clarified `file.read` guidance for indexed source.

_8 commits from 2 contributors_

## [0.11.13] - 2026-06-27

### Added

- **SDLBench**: Added the OpenCode agent integration, sterile runtime dispatch path, session token extraction, product lock entry, Neuralwatt pricing, and the P1/P2 proof surfaces.

### Changed

- **Provider-first indexing**: Honored the stable DB writes flag during native pass1 serialization.
- **SDLBench**: Added OpenCode + GLM-5.2 validating run data and refreshed OpenCode documentation.

### Fixed

- **Server shutdown and startup**: Handled broken stdio pipes during shutdown and hardened startup DB cleanup plus FTS bootstrap.
- **Provider-first validation**: Fixed coverage-scan fallback behavior, Moshi real targets, and import retry handling.
- **SDLBench**: Fixed scaling runner aggregation, CLI root argument handling, sample-run coverage, OpenCode runtime/parser handling, and OpenCode CLI command templating.

_18 commits from 1 contributor_

## [0.11.12] - 2026-06-26

### Changed

- **Provider-first indexing**: Extracted provider path filtering into the materializer and added multiline Rust `PartialEq` fallback coverage.
- **SDLBench**: Switched reports to Codex session token counts and tightened agent timeout handling.

### Fixed

- **CI memory sync**: Forced the Linux sync-memory path through the TypeScript fallback for more stable indexing.
- **Codex behavior isolation**: Isolated Codex behavior runs from ambient agent context.
- **SDLBench viewer**: Fixed filter behavior and improved bar readability.

_7 commits from 1 contributor_


## [0.11.11] - 2026-06-25

### Added

- **Provider-first language coverage**: Added Zig, Julia, Gleam, Nix, OCaml, and Haxe provider metadata/support, validated Clojure and D provider-first support, and added lazy language-pack structural matcher support.
- **SDLBench**: Added the SDLBench benchmark harness.

### Changed

- **Semantic defaults**: Enabled SCIP and semantic enrichment by default.
- **Provider-first validation docs**: Completed the Wave 3 language chart, refreshed provider-first fixture snapshots, and recorded blockers for Ada, Elm, Erlang, Nim, Crystal, V, Racket, Raku, and ReScript.
- **Token savings demo**: Replaced checked-in demo media with README and presentation video/poster links, and documented verbatim usage-stats reporting.
- **CI benchmark guardrails**: Relaxed provider-first SCIP CI guardrails and refreshed benchmark DB connections after indexing.

### Fixed

- **Provider-first shadow finalization**: Fixed derived endpoint handling during shadow finalization.
- **Watcher retries and diagnostics**: Coalesced watcher reindex retries, added active dispatch labels to timeout diagnostics, and tightened generated init-enforcement assets.
- **README demo links**: Fixed README formatting and SDL Token Savings video links.

_41 commits from 2 contributors_

## [0.11.10] - 2026-06-24

### Added

- **OpenAI tool naming**: Added an OpenAI-compatible tool-name format option for tool metadata surfaces.

### Changed

- **Agent workflow guidance**: Clarified `sourceWindow` usage and adjusted agent workflow validation around root-only agent docs and local agent files.
- **Validation docs**: Moved validation evidence and devdocs artifacts to internal surfaces so public release contents stay clean.

### Fixed

- **Provider-first shadow finalization**: Fixed endpoint handling in provider-first shadow finalization.

_11 commits from 1 contributor_

## [0.11.9] - 2026-06-23

### Added

- **Setup wizard**: Added guided `sdl-mcp init` and postinstall setup flows, including the `create-sdl-mcp` wrapper and agent configuration checks.

### Changed

- **Indexing and retrieval workflows**: Refined SDL setup, indexing, retrieval, and token-meter docs/configuration for the updated workflow surfaces.
- **Watchman startup**: Extracted the startup probe helper and tightened provider coverage around Watchman startup behavior.
- **Agent guidance**: Refactored repository AGENTS guidance, root agent file ignores, and repo ID handling across the root, Codex, Claude, native, source, and fixture surfaces.

### Fixed

- **Provider-first shadow finalization**: Fixed missing edge-source handling so provider-first shadow finalization preserves expected dependency relationships.
- **Release workflow surfaces**: Tracked required root agent instructions plus Codex/Claude SessionStart and SDL Explorer agent files so CI docs workflow checks use the same surfaces as local release gates.

_11 commits from 1 contributor_

## [0.11.8] - 2026-06-21

### Added

- **Provider-first incremental indexing**: Added provider-first incremental indexing and rebuilt Symbol FTS around provider replacement so incremental provider runs keep search state aligned.

### Changed

- **SDL workflow guidance**: Refined context retrieval, workflow dependency handling, edit guidance, runtime docs, file-read extraction, and generated tool documentation/templates.
- **Runtime logging and Watchman setup**: Default server file logging now creates a unique session log file instead of appending every run to `sdl-mcp.log`; Watchman install/probe handling and managed package restaging were hardened.
- **Provider-first behavior**: Scoped provider-first fallback failures, clarified auto fallback reasons, and constrained provider inputs to provider-first paths.

### Fixed

- **Runtime and CI stability**: Fixed Node runtime code execution with stdin, CI runtime artifacts, PHP CRLF call handling, CI parity, provider-first test gates, and nightly benchmark matrix isolation.
- **Index and retrieval correctness**: Preferred expected-name matches in source call proof, repaired missing file summaries during no-op recovery, aligned gateway tests with the current action set, and excluded control-plane tools from savings rankings.

_27 commits from 2 contributors_

## [0.11.7] - 2026-06-17

### Added

- **Provider-first LSP indexing**: Added provider-first LSP execution, normalization, lazy language-pack loading, and validation coverage across the wave 0, wave 1, and wave 2 provider set, including Dart, Elixir, F#, Fortran, Groovy, Haskell, Lua, Perl, PowerShell, R, Ruby, and Swift.
- **PHP and shell provider coverage**: Extended provider-first coverage to PHP and shell adapters so those languages participate in the same language-provider support inventory and validation path.
- **Language provider inventory**: Added a generated language-provider support report and checker script so documented provider, parser, and fallback support stays synchronized with the package surface.

### Changed

- **README and provider docs**: Replaced README Mermaid diagrams with optimized image assets and refreshed provider-first indexing, SCIP, configuration, tool, and semantic documentation for the expanded provider-first language support.
- **Dependency coverage**: Updated OpenTelemetry trace packages to 2.8.0 and added missing tree-sitter grammar package coverage required by the release guard.

### Fixed

- **LSP client robustness**: Handled dynamic LSP client registration requests and hardened request timeout handling so provider-first LSP runs behave predictably with slower or capability-negotiating servers.
- **Provider normalization edge cases**: Normalized JVM constructor/type references and scip-dotnet descriptors, and tightened shadow CSV quoting so provider-first materialization handles .NET and JVM edge cases.
- **Release guardrails**: Tightened release regressions around grammar availability and provider-first language coverage so missing runtime support is caught before publishing.

_21 commits from 1 contributor_

## [0.11.6] - 2026-06-15

### Fixed

- **Native Go parser stability**: Updated the native Rust tree-sitter runtime and Go grammar to the 0.25 line so valid Go files parse through the native addon instead of returning `tree-sitter parse returned None` or risking stale grammar crashes. Added Rust and Node-level dependency regressions for the native Go parser path.
- **Provider-first Go SCIP normalization**: Skipped scip-go's synthetic empty-path package document, normalized backtick-wrapped Go import-path descriptors before SCIP kind/name mapping, and made shadow finalization honor freshly staged unresolved/external symbol classifications when copying active edges, symbol versions, metrics, and parity counts. This prevents fake `.` files, import-path-shaped Go symbol names, and stale active provider metadata rows from blocking provider-first shadow activation.
- **Stable derived-state startup recovery**: Skipped canonical Cluster and Process row rewrites when computed derived-state topology is unchanged, avoiding LadybugDB FTS access violations from no-op `searchText` updates while still repairing missing Cluster FTS indexes.

### Security

- **Dependency audit cleanup**: Raised the transitive `tar` override to 7.5.16 and refreshed Babel lockfile entries to patched 7.29.7 releases, restoring a clean `npm audit --audit-level=moderate` gate.

_4 commits from 1 contributor_

## [0.11.5] - 2026-06-15

### Added

- **AST-aware search edit languages**: Extended `search.edit` `targeting:"identifier"` and `targeting:"structural"` beyond TypeScript/JavaScript to all built-in tree-sitter adapters, with plugin `structuralMatcher` descriptors for opt-in language support.
- **Pass-1 drain diagnostics**: Added opt-in batch row counts and sub-timings for pass-1 write flushing so `deleteOldSymbols`, file upserts, symbol references, symbol upserts, and `DEPENDS_ON` edge inserts can be profiled independently against a temporary graph DB.
- **SCIP generator diagnostics**: Index refresh results and audit payloads now report generated SCIP indexes, skipped generated files, and non-fatal generator/ingest failures.
- **Algorithm refresh controls**: Added `indexing.algorithmRefresh` config for worker-bounded PageRank/K-core and Louvain policy limits.
- **Provider-first SCIP execution**: Added the provider-first indexing foundation for SCIP refreshes, including provider fact collection, stable provider IDs, LadybugDB graph-row materialization, CLI/SSE fallback reporting, full-refresh execution for completely covered SCIP indexes, and explicit errors when `indexing.pipeline: "providerFirst"` is configured but provider execution or coverage is incomplete.
- **Provider-first shadow staging**: Provider-first SCIP runs now write provider-materialized rows as streaming table-shaped CSV artifacts plus a manifest beside the active graph DB, preserving node-before-relationship load order. When same-run legacy fallback parses uncovered or provider-unusable files, the final shadow staging pass also includes those just-written active graph rows. The same phase bulk-loads those artifacts into a fresh shadow `.lbug`, uses explicit CSV null handling so empty-string sentinels remain value-faithful, disables parallel CSV reading so quoted newlines in provider symbol text load correctly, builds secondary indexes when supported, checkpoints, and validates actual loaded row counts against expected counts before reporting the shadow DB loaded. Artifact or shadow-load failures are reported as skipped staging/load work and do not block the active LadybugDB materialization path after provider graph validation succeeds; unsupported `CREATE INDEX` runtimes and secondary-index build failures are surfaced as non-fatal shadow DB warnings.
- **Provider-first shadow finalization and activation**: Loaded provider-first shadows are now finalized after active graph finalization by writing auxiliary dependency symbols, final active edges, version rows, symbol versions, metrics, file summaries, clusters, processes, shadow clusters, and derived-state rows to finalization CSV artifacts and loading them into the shadow `.lbug` with LadybugDB `COPY`, then validating active-versus-shadow counts before activation preflight. Finalized shadow summaries keep public real-symbol counts separate from unresolved or external auxiliary dependency symbols copied for edge parity and expose the finalization copy mode plus artifact manifest for diagnostics. Finalization now seeds non-repo-linked edge-target symbol nodes without adding missing repo links, and relationship rows with quoted endpoints, record separators in endpoint/property text, or CSV-quoted `pass2-cpp` provenance fall back to parameterized writes so unresolved quoted or multi-line dependency, cluster, process, shadow-cluster, and C++ pass-2 edge rows do not break activation. Live provider-first runs now close the active LadybugDB pool, swap the finalized shadow `.lbug` into the active path, reopen the active DB for follow-up reads, keep the previous active DB as a backup, and roll back if activation or reopen fails.
- **Provider-first phase timings**: Executed provider-first runs now include a normal CLI timing block with total provider-first wall time, the slowest provider-first bucket, phase durations for collection, coverage scan, active materialization, same-run legacy fallback, final shadow staging, shadow finalization, and activation, plus active materialization subphase timings for provider-owned symbol deletion, file upserts, symbol upserts, stale external pruning, external-symbol merges, and edge inserts. Provider-owned symbol upserts also report the combined `nodeAndRelCreate` bucket so materialization tuning can track the provider symbol-node and ownership relationship COPY load separately from the outer symbol phase. These timings do not require broad `--diagnostics` output.
- **Provider-first live progress**: Index progress now has a first-class `providerFirst` stage with substages for coverage scanning, provider metadata/document/external-symbol/source-line collection, normalization, graph-row shaping, validation, coverage analysis, active materialization, shadow staging, shadow finalization, and shadow activation. The existing CLI, HTTP reindex stream, and MCP progress notifications all receive the same stage/substage payloads with counters when totals are known and heartbeat messages when totals are not.
- **Provider-first fallback diagnostics**: Provider-first runs that still parse uncovered or provider-unusable files through same-run legacy fallback now report fallback file count, total and average fallback time, the slowest fallback subphase, pass1/pass1-drain/pass2/finalize buckets, nested `finalizeIndexing` subphases, derived subphase buckets, version snapshot details (`latest`, `create`, `snapshot`, `readPages`, `writePages`), deferred-index details (`secondary`, `config`, `retrieval`), deferred retrieval lifecycle details (`symbolDiscovery`, `symbolFts`, `symbolVectors`, `entityDiscovery`, `entityFts`, `fileSummaryVectors`, `agentFeedbackVectors`), secondary buckets such as shared-state initialization, import re-resolution, edge finalization, versioning, deferred indexes, and memory sync, plus an unaccounted residual and sample fallback paths. Nested finalization, version snapshot, and deferred-index timings are collected for provider-first fallback even when broad index diagnostics are disabled, including Metrics write execution/wait buckets, FileSummary load/build/write subphases, and retrieval index lifecycle subphases.
- **Provider-first pass-2 diagnostics**: Provider-first fallback diagnostics now include pass-2 target-selection, import-cache, resolver-dispatch, write-active, write-queue, COPY placeholder-repair, placeholder symbol-metadata repair, placeholder repo-link repair, COPY insert, and generic repair-insert timing buckets. COPY insert timing is split into temporary CSV materialization and `COPY DEPENDS_ON FROM`, and generic repair-insert timing is further split into row preparation, source repo-link symbol metadata, source repo-link relationship repair, endpoint metadata, target metadata, target repo-link repair, relationship create, and relationship update. Pass-2 write counters also report flushes, COPY edges, placeholder rows, skipped repeated placeholder rows, repair cause rows, repair cause drift, effective repair rows, and small COPY batches. Resolver diagnostics include per-resolver phase timing buckets plus count/size metrics such as file bytes read, include-index files parsed, cache hits, and extracted call counts for attribution inside heavy pass-2 resolvers. This makes large-repo fallback runs distinguish resolver CPU/read work, LadybugDB writer time, placeholder target repair, repo-link repair, unsafe endpoint repair, small COPY-safe batch fallback, and relationship import volume without enabling broad index diagnostics.
- **Index runtime provenance**: `sdl-mcp index` now prints the loaded SDL-MCP package version, Node.js version, and command module path, and delegated HTTP indexing reports the server process runtime identity so benchmark logs can distinguish current builds from stale global installs or long-lived servers. Per-repo summaries also report caller-visible wall time separately from indexed-phase duration so SCIP generator/pre-refresh cost is visible in normal logs.
- **SCIP generator cache**: Generated scip-io artifacts are cached under `~/.sdl-mcp/cache/scip-io/` by source/config fingerprint and restored on unchanged refreshes, avoiding expensive compiler generator runs on repeated full indexes. Warm hits use a latest stat-signature manifest before falling back to the exact content-hash fingerprint path, keeping large unchanged repos from hashing every input file just to restore cached SCIP output. Usable generated indexes are now cached even when `scip-io` exits nonzero because another requested language failed, so mixed-language repos can reuse the successful language artifact on the next unchanged run. CLI summaries report generator cache hit/store diagnostics when the cache participates, including separate generator, prepare, save, and restore timing buckets when available.
- **Provider-first coverage denominators**: C/C++ provider-first summaries now split the broad SDL-MCP scan scope from SCIP semantic eligibility. The semantic denominator is the union of scan-scope files named by discovered `compile_commands.json` entries and provider-emitted C/C++ header/include documents inside scan scope, while provider document counts still report the SCIP docs emitted inside scan scope.

### Changed

- **CI benchmark guardrails**: Kept `benchmark:ci` on Linux but made it a JavaScript/LadybugDB regression gate by explicitly disabling the native addon and removing the native-build dependency. Native crash and parity coverage stays with the native-build and sync-memory jobs, while the benchmark lane continues to catch threshold regressions without Linux exit-139 flakes from the addon path.
- **CI pass-1 write stabilization**: Added `SDL_MCP_PASS1_STABLE_DB_WRITES=1` for CI indexing lanes so pass-1 LadybugDB flushes do not overlap native tree-sitter or Rust parsing in the same Node process. This preserves native sync-memory coverage while avoiding hosted-runner exit-139 crashes at the parser/graph-write boundary.
- **CI sync memory setup**: Restored locked external benchmark repo setup in the sync-memory job so the default SDL-MCP config can index every configured repository before exporting CI memory artifacts.
- **Provider-first provider collection**: Normal CLI timing output now breaks down the provider collection bucket into SCIP metadata, document decode, external-symbol loading, source-line loading, normalization, row shaping, and validation subphases. Provider source-line loading also retains broad import-alias context only for alias-bearing import lines, reducing provider-first memory and normalization work for large repos with many plain imports.
- **Pass-1 write batching**: Centralized LadybugDB write chunk sizing, raised safe edge/reference/file defaults to reduce pass-1 prepared statement count, let pass-1 skip redundant existing `DEPENDS_ON` refreshes after source-symbol replacement, moved full-refresh stale-symbol deletion ahead of pass-1 flushes, and collapsed file-scoped stale symbol relationship cleanup into one `DETACH DELETE` pass while keeping ID-keyed metrics/reference/cache cleanup explicit.
- **SCIP generated index handling**: Raised decoder file caps to 512 MiB and added generated split-index fallback with SHA-256 dedupe for identical TypeScript/JavaScript split artifacts.
- **Provider-first safety**: Allowed active SCIP provider-first execution only after coverage validation, so `auto` uses legacy fallback when SCIP execution or coverage is incomplete and explicit `providerFirst` fails loudly instead of replacing the live graph with partial provider data.
- **Provider-first readiness**: Split semantic readiness from provider-first graph readiness so SCIP provider-first indexing skips inline semantic refresh, reports deferred semantic readiness in CLI output, and leaves semantic derived state dirty for later refresh.
- **Provider-first SCIP calls**: Promoted SCIP reference occurrences to exact `call` edges only when repo source lines prove the expected symbol text plus invocation syntax, including constructor symbols whose SCIP display name is `` `<constructor>` `` but whose source token is the owning class in `new ClassName(...)`, synthetic type-literal member symbols whose source token is the member suffix, Python nested callable descriptors such as `eventclass().wrapper` whose source token is the terminal callable `wrapper`, Python import aliases where SCIP ranges cover the full `name as local_name` clause, C++/clang qualified, member, and template calls whose retained local token window proves the terminal callable and invocation syntax, C++ constructor declarations such as `APInt Offset(...)` when the provider symbol is the constructor and the declarator range points at the variable name, C++/clang location-only macro descriptors such as `` `.../assert.h:77:11`! `` whose source token is an invoked identifier, and single-line or multi-line named-import aliases such as `import { original as localAlias }`. Python module initializer references that expand to a qualified member invocation, such as `lit.util` inside `lit.util.warning(...)`, remain neutral because the module is not the invoked callable. Non-import TypeScript `as` expressions are ignored for alias proof. Readable non-call references, such as property keys and broad value reads, remain neutral occurrence facts without blocking call-proof readiness. C++ qualifier-only references, template-argument references, invocation-like text inside string/comment literals, and mismatched all-caps macro wrapper tokens remain neutral occurrence data instead of call-proof failures. Unresolved references, invocation-shaped stale SCIP ranges on the actual callable token, and unavailable source lines stay conservative. Provider-first source loading now includes bounded import blocks plus small C++ reference windows so alias and multi-line C++ proof work in real SCIP execution, not just in direct normalization tests. Provider-only SCIP runs compute graph-derived cluster/process/algorithm state only when call proof is complete; otherwise they leave graph-derived readiness dirty with an operator-visible health reason. CLI coverage output now groups incomplete call-proof reasons with reference counts, affected file counts, sample paths, and bounded expected/actual samples for symbol-text mismatches.
- **Provider-first C++ call-proof follow-up**: Treats overlapping clang macro-expansion ranges such as `clEnumValN(...)` and location-only macro tokens such as `offsetof(...)` as neutral when scip-clang maps namespace, type, enum, or member symbols onto the invoked macro token, proves constructor calls in member-initializer lists when the occurrence range points at the member name but nearby declarations expose the constructed type, proves trailing local-class declarator constructors such as `struct RestorePath { ... } restore_path(path);`, proves typedef-alias constructor declarations such as `MutexLock l(&mutex)` when SCIP also exposes the alias type occurrence in the same descriptor scope, proves unary/operator-token references such as `operator~` and `operator()` when clang ranges the source operator token, normalizes backtick-wrapped clang descriptor names and balanced trailing template arguments such as `` `~V8` `` and `ScopedHashTableScope<K, V>` to their source spelling, and keeps implicit result/conversion references neutral for C++ named casts, callable-object invocations, constructor conversions over a different expression call token, and conversion-operator declarations such as `operator ArrayRef<T>()`.
- **Provider-first C++ multi-line call proof**: Allows clang/cxx multi-line provider ranges to enter the bounded C++ token-window proof when source lines are retained, proving multi-line template/member invocations while keeping broad non-call ranges and C++ control-flow keywords neutral.
- **Provider-first C++ literal and declarator proof**: Keeps clang/cxx string literal spans reported as implicit `StringRef` constructor references neutral, including UTF-8 byte-column ranges over non-ASCII literals, and proves constructor references in comma-separated declarations such as `APFloat MA(Sem), SC(Sem)` from the shared exposed type.
- **Algorithm refresh policy**: Lowered the default Louvain `maxCallEdges` threshold from `50000` to `10000` so optional shadow community detection is policy-skipped before it dominates provider-first full-index wall time. PageRank and K-core still run by default.
- **Version snapshot batching**: Replaced per-symbol `SymbolVersion` snapshot writes with cursor-paged symbol snapshot reads. Fresh full-index versions now stream larger bounded read pages into one buffered CSV artifact and one LadybugDB `COPY`, while repair/reuse paths keep chunked `UNWIND MERGE` writes so incomplete or reused snapshots can still be safely filled.
- **Provider-first memory release**: Explicitly releases decoded provider fact payloads and discarded graph-row copies after provider coverage analysis so large SCIP runs do not carry occurrence/source-line arrays into same-run legacy fallback and version snapshot creation.
- **Provider-first active materialization**: Provider-first active graph writes now use a known-fresh symbol writer that writes provider `Symbol`, `SYMBOL_IN_FILE`, and `SYMBOL_IN_REPO` rows to temporary CSV artifacts and imports them with LadybugDB `COPY`, plus a known-endpoint edge loader that writes provider `DEPENDS_ON` rows to a temporary CSV and imports them with LadybugDB `COPY` inside the active transaction. This avoids generic relationship existence checks, endpoint repair, stale optional-field preservation, per-row endpoint matching, and the extra symbol or edge relationship probes needed by broader legacy writes before shadow activation while leaving the legacy writer defaults unchanged.
- **Provider-first active-row reuse**: Medium repeat provider sets now retire stale active rows in chunks and reload them with the known-fresh COPY writer up to 100k provider symbols, avoiding the slow merge-safe symbol path for LLVM-sized C/C++ refreshes. Larger active provider-row reuse is gated by a recorded generated-SCIP input fingerprint; if the generated provider artifact changes, SDL-MCP runs merge-safe file and symbol upserts instead of reusing stale active rows solely because the existing provider symbol set is large.
- **Metrics materialization**: Full post-index metric refresh now replaces the repo's current `Metrics` rows with a delete-plus-`COPY` transaction from a buffered temporary CSV, while partial incremental refreshes keep merge-safe batched upserts. Full refreshes also persist a repo-level metrics payload fingerprint and skip the delete-plus-`COPY` entirely when fan/churn/test/canonical/centrality values are unchanged, leaving `updatedAt` stable instead of rewriting rows just to move timestamps. This removes the large full-index `UNWIND MERGE` metrics write loop without risking data loss for scoped updates.
- **Provider-first fallback Metrics writes**: Incremental Metrics writes now probe existing Metrics IDs inside the write transaction, COPY-load absence-proven missing rows above the threshold, directly create small missing batches, and `MATCH`-update existing rows. Provider-first fallback diagnostics surface the nested Metrics write phases so fresh isolated benchmark runs can distinguish probe, CSV materialization, COPY, direct-create, and existing-row update costs.
- **Metrics test-reference cache**: Test-reference discovery now persists per-repo matched test symbols in the SDL-MCP temp cache with file size and content-hash metadata, so repeated one-shot CLI full indexes can reuse unchanged test-file matches instead of re-reading and re-tokenizing every test file. Metrics refreshes reuse the already-loaded indexed file list and content hashes as the candidate test-file set, avoiding a second filesystem glob walk over large repositories and filesystem stats for unchanged cached test files while keeping ignored or unscanned files out of graph metrics. Warm runs collect candidate names from cached refs and changed test-file tokens before building the current symbol-name lookup, so large provider-first repos no longer allocate name buckets for every symbol when only a small subset appears in tests. Duplicate-heavy symbol names are treated as low-signal test-reference tokens to avoid attaching one test file to hundreds of same-named symbols in large repositories.
- **FileSummary materialization**: File summary refresh now compares the newly generated `summary` and `searchText` with existing `FileSummary` rows and skips unchanged payloads instead of rewriting every file-level summary just to advance `updatedAt`. Full-repo summary refreshes use direct `Symbol.repoId` symbol reads instead of giant `fileId IN (...)` predicates or extra `SYMBOL_IN_REPO` traversals, derive exported-name search text from the same symbol facts, and in provider-first full runs consume provider-owned symbol facts directly from the already materialized provider rows so the summary phase only queries LadybugDB for fallback-owned files. Changed existing rows use a node-only update path that avoids File/Repo relationship probes, and first-time summary rows are loaded through temporary CSV artifacts with LadybugDB `COPY` for `FileSummary`, `FILE_SUMMARY_IN_REPO`, and `SUMMARY_OF_FILE`. The merge-safe upsert path remains the fallback if the known-new COPY insert fails. The reported `updated` count reflects rows actually written.
- **Provider-first pass-2 imports**: Provider-first full runs now seed pass-2 import caches from provider-owned graph rows. The generic import resolver gets exported `(symbolId, name)` facts without re-reading provider-owned files from LadybugDB, and Python pass-2 also receives exported kind/range details so imported class-method resolution can avoid per-target `getSymbolsByFile` reads for provider-owned modules while preserving the DB fallback for legacy-owned files.
- **Provider-first pass-2 writes**: Full-mode pass-2 now splits COPY-safe call edges from repair-only edges. Large COPY-safe batches use the known-symbol `DEPENDS_ON` COPY path after source-symbol replacement and bulk placeholder repair for safe unresolved targets, while small batches and rows with unsafe relationship endpoints or copied edge properties that require CSV quoting keep the generic writer with full-mode skip flags so COPY setup overhead does not dominate small fallback runs and rare C++ provenance with commas, quotes, or newlines cannot break the relationship CSV load; incremental pass-2 remains on the refresh-capable generic writer.
- **Provider-first C/C++ pass-2 fallback performance**: C++ pass-2 now groups call sites by owning symbol once per file, warms the shared include index before per-file resolution, uses a resolved-value include-index cache after warmup, reuses the pass-level C++ include index for current-file symbol mapping, scopes include-index import parsing to active pass-2 target files, reuses pass-1 C++ imports/content for include-index resolution and pass-1 source text for current-file parsing without reusing pass-1 calls, builds namespace-member lookups from the same cached repo symbol rows with a linear namespace-prefix pass instead of a namespace-by-symbol cross product, and avoids promise-await overhead for synchronous pass-2 batch submissions. It also raises the sequential full-mode pass-2 flush default to `256` files / `32,768` edges, skips no-op fresh-copy incoming-symbol deletes when none of the incoming IDs exist in the current graph, avoids repeated unresolved-placeholder target repair during full-mode pass-2 COPY batches once a target was successfully ensured earlier in the same pass, and groups placeholder repo-link repair by `repoId` so each chunk matches the repo once instead of per row. C pass-2 now reuses a pass-level repo symbol index for current-file symbol lookup, groups calls by owning symbol once per file, and shares the same synchronous batch-submit path, cutting large LLVM fallback C resolver work while preserving pass-2 C edge counts. Full-mode generic repair now also skips the existing-relationship probe for fresh pass-2 call edges, groups target placeholder repo-link repair by repo, and keeps non-real target metadata off the file-backed cleanup join, preserving duplicate-protection for general `insertEdges` callers while reducing the provider-first repair writer. The provider-first fallback benchmark harness also clears graph DB path environment overrides for child index runs so per-repeat graph DB artifacts are authoritative.
- **Provider-first unresolved-call cleanup**: Final edge cleanup now gathers distinct unresolved call target IDs, applies the existing builtin classifier once per target, and deletes repo-scoped call relationships to builtin targets directly in LadybugDB with duplicate-safe relationship deletion. This preserves dotted-call semantics such as `console.log` while avoiding materializing every unresolved call edge and then replaying `(from, to, type)` delete rows through the generic edge deleter.
- **Cluster/process replacement writes**: Full cluster and process replacement now uses dedicated post-delete relationship insert helpers for `BELONGS_TO_CLUSTER` and `PARTICIPATES_IN` rows. The generic upsert helpers still keep probe-and-update semantics for partial callers, while full replacement skips redundant `OPTIONAL MATCH` and second update passes after old relationships have already been removed.
- **Provider-first fallback pass-1 stability**: Complete same-run provider-first legacy fallback now uses the tuned legacy machinery, including native Rust pass-1 when configured and available, parser workers for TypeScript pass-1, normal configured concurrency, and the batch persistence accumulator. Intentionally partial provider-first fallback remains on inline TypeScript parsing and direct per-file LadybugDB writes because shadow activation is already blocked by the skipped tail and that mixed partial path has hit hard native and worker exits on large C++ repos.
- **Provider-first shadow handoff**: Full provider-first runs now skip expensive shadow DB staging and finalization when call-proof gaps or fallback-cap gaps have already made graph-derived state dirty and activation impossible. The active graph still finalizes normally, and CLI output reports the skipped shadow reason instead of spending time building a shadow DB that cannot be finalized or swapped into place.
- **Provider-first fallback caps**: Same-run legacy fallback after provider-first materialization is now guarded by `indexing.providerFirst.maxLegacyFallbackFiles` (default `1000000`). The high default keeps full provider-first graphs complete by routing broad uncovered or provider-unusable tails through the tuned legacy fallback path; lowering the cap remains available for partial iteration or resource protection, and capped runs report the skipped count while leaving graph-derived readiness deferred.
- **Provider-first semantic fallback cap**: Added `indexing.providerFirst.maxSemanticEligibleFallbackFiles` (default `0`) for the special case where the full fallback gap is over `maxLegacyFallbackFiles` but a semantic-eligible subset is known. SDL-MCP skips that partial subset by default because the skipped outside-semantic tail still blocks shadow finalization and activation; users can raise the new cap when active-graph fallback coverage is worth the extra indexing time despite the partial graph.
- **Provider-first deferred index work**: Provider-first runs that defer semantic refresh now defer Symbol FTS, entity FTS, and Symbol/FileSummary vector-index creation out of the indexing wall-clock. A later non-fresh startup or readiness refresh bootstraps retrieval indexes, while semantic embedding refresh rebuilds HNSW vector indexes after actual vector rows are written.
- **Cluster/process materialization**: Canonical cluster and process refresh now batch parent node updates and flatten member/step relationship rows into one batch per refresh instead of issuing one parent write plus one relationship batch per cluster or process. Provider-first fallback diagnostics now surface `clusterWrite.*` and `processWrite.*` subphase timings so derived-state write bottlenecks remain visible in normal CLI output.
- **SCIP generator language filtering**: `scip-io` pre-refresh now derives a `--lang` filter from the repo's configured `languages`, so TypeScript/JavaScript/Rust repos do not invoke unrelated Java, C#, Go, C++, or other generators. Explicit `--lang`/`-l` entries in `scip.generator.args` still override the automatic filter, and split fallback ignores unchanged pre-existing split files so stale artifacts from unrelated languages are not ingested.
- **Provider-first coverage diagnostics**: CLI coverage output now breaks down the `provider unusable` bucket by reason, including missing coverage facts and provider-covered files with no usable symbols, plus skipped-symbol reason counts when provider symbols were emitted but SDL-MCP did not materialize them. Rust module descriptors ending in `/` now materialize as SDL `module` symbols instead of being reported as unknown descriptor suffixes, reducing provider-unusable fallback for Rust `mod.rs` files. Repeated rust-analyzer crate namespace symbols such as `crate/` are coalesced into one provider symbol so expected namespace duplication does not trip the unsafe duplicate-symbol guard. C++ provider symbols emitted with the `cxx` scheme now use clang-style descriptor mapping, and ambiguous native symbols with definitions in multiple files are skipped as provider-unusable facts instead of aborting the whole SCIP provider run.
- **Provider-first staging format**: `indexing.providerFirst.stagingFormat: "parquet"` currently records a Parquet-to-CSV fallback reason in the staging manifest because CSV is the implemented bulk-load artifact format for this phase.

### Fixed

- **Retrieval index failure surfacing**: Required retrieval index creation failures during the post-full-index deferred bootstrap now stop the index run with the failed index names instead of being swallowed and later appearing only as `FTS: ABSENT` in `doctor`.
- **File watcher ignores**: Compiled repository ignore globs into the Chokidar startup predicate so modern Chokidar versions prune ignored directories such as `node_modules`, `.bun`, `dist-*`, and build outputs before opening watches. Watcher event filtering now reuses the same glob semantics and the scanner's language-extension mapping, keeping watcher scope aligned with indexed source files and preventing `EMFILE: too many open files, watch` storms in dependency-heavy repos.
- **MCP tool schema compatibility**: Flattened root-level `oneOf`/`anyOf`/`allOf` composition in advertised tool input schemas, including `sdl.search.edit`, `sdl.symbol.edit`, and gateway wire schemas, so Claude/Anthropic clients that require top-level `type: "object"` schemas can accept SDL-MCP tool lists while runtime Zod validation remains strict.
- **Cluster refresh crash**: Dropped and rebuilt the Cluster FTS index around topology-changing cluster replacement so LadybugDB does not access-violate when deleting the old cluster set during delegated incremental indexing. Rebuilds now fail closed when FTS is available, skip only when the global Cluster table is empty, and recreate Cluster FTS when rows return after an absent-index state.
- **FTS bootstrap safety**: Deferred FTS index creation for empty entity tables and made FTS existence checks table-aware so same-name indexes on other tables do not mask missing required indexes.
- **Plugin adapter startup**: Loaded configured plugin adapters during server, CLI serve, direct indexing, and CLI tool startup so plugin `structuralMatcher` descriptors are available to `search.edit`, and resolved configured plugin paths relative to the config file with trusted-root containment.
- **Search edit hardening**: Reused realpath-validated, handle-based, size-capped file reads for single and batch previews; capped structural `requiredCaptures` maps to bounded safe keys; and added an aggregate structural query time budget that is checked before candidate parsing.
- **Batch search edit safety**: Recomputed batch operation ranges from the aggregate-read content instead of diffing against stale per-operation preview output, deduplicated same-file byte accounting across child operation previews, and compacted stored skipped-file summaries.
- **Index drop confirmation**: Made missing `DROP_FTS_INDEX`/`DROP_VECTOR_INDEX` procedure/function handling fail closed unless strict `SHOW_INDEXES` introspection confirms the table index is absent, with missing table metadata treated as unconfirmed.
- **LadybugDB extension reloads**: Guarded replacement connection `LOAD EXTENSION` calls with a pre-load WAL checkpoint and cleared global extension capability state on per-connection load failures so recycled sessions do not bypass the dirty-WAL crash guard.
- **CLI plugin loading**: Delayed direct CLI plugin imports until local adapter registry state is needed, avoiding plugin execution for delegated indexing and metadata-only tool commands.
- **Gateway validation parity**: Mirrored direct `search.edit` string and array caps in the repo gateway schema.
- **Structural search-edit validation**: Candidate-specific tree-sitter query compilation failures now surface as validation errors instead of false no-match previews.
- **LadybugDB algorithm refresh**: Drop and rebuild repo-scoped projected graphs before post-index algorithm refresh so long-lived HTTP server connections do not reuse stale projections during incremental indexing.
- **Large-repo indexing memory**: Released pass-1/pass-2 symbol-map bridge caches before version snapshot creation so large full indexes do not carry full-repo symbol maps into post-index finalization.
- **Incremental metrics recovery**: No-op incremental refreshes now inspect the current graph for incomplete version snapshots, missing metrics/file summaries, stale or absent derived state, and configured SCIP indexes before returning. Missing `Metrics` rows are repaired through a dedicated LadybugDB aggregate/write path instead of hydrating the full edge graph, while SCIP edge changes still use the full recomputation path for correctness.
- **Algorithm refresh timeouts**: Canonical cluster/process refresh now completes independently of optional graph algorithms; PageRank/K-core run in a killable worker, centrality writes are preserved before Louvain, and large call graphs skip Louvain by policy instead of timing out the post-index session.
- **Provider-first graph facts**: Kept SCIP provider symbol IDs stable across line movement, stopped promoting broad SCIP reference occurrences to exact call edges, pruned stale SCIP external symbols during full provider materialization, and batched external-symbol writes to avoid thousands of single-writer round trips.
- **Provider-first duplicate SCIP facts**: Coalesced duplicate SCIP documents for the same normalized repo-relative path and duplicate symbols/occurrences inside a document before provider fact emission, preserving unique facts without producing duplicate `File` or `Symbol` primary keys in large multi-root SCIP indexes.
- **Provider-first SCIP symbol ownership**: Stopped materializing referenced-only SCIP `SymbolInformation` metadata as file-local symbols. Occurrences in reference documents now resolve to the definition document's provider symbol, preventing `scip-python` duplicate native symbol failures while preserving true multi-definition collisions for validation.
- **Provider-first scan scope**: Safe repo-relative SCIP documents that fall outside the configured repository scan scope, such as files for languages not listed in the repo config, are now filtered from provider facts and rows instead of aborting the run. Absolute or path-traversing provider paths still fail coverage validation.
- **Scanner language extensions**: Repository scans now derive source extensions from the built-in adapter registry for configured C, C++, Python, PHP, Kotlin, and shell languages, so provider-first coverage no longer ignores valid `.cc`, `.cxx`, `.hh`, `.hpp`, `.hxx`, `.h`, `.pyw`, `.phtml`, `.kts`, `.bash`, and `.zsh` files solely because the repo language was configured by its short SDL-MCP language ID. Configured C++ scan scope now also includes provider-emitted C/C++ companion extensions `.c`, `.h`, `.def`, and `.inc`, and configured Python includes `.pyi`, so safe SCIP documents for headers, generated include fragments, and Python stubs are not filtered out before provider materialization.
- **Provider-first generator warnings**: Full provider-first runs now continue after `scip-io` reports per-language generator failures when a usable SCIP index still decodes into provider rows; missing configured SCIP index files remain fatal for explicit `providerFirst` and legacy-fallback triggers for `auto`.
- **Provider-first external snapshot boundary**: Version snapshots and shadow finalization now exclude `external=true` dependency support symbols even if stale metadata still labels them as `symbolStatus: "real"`. Shadow parity treats those nodes as auxiliary and copies `SymbolVersion` and `Metrics` rows only for repo-owned non-external symbols, so activated provider-first shadows do not inflate public symbol or version counts.
- **Scanner glob scope**: Corrected wildcard directory ignores such as `**/dist-*/**` so generated `dist-*` directories remain excluded while checked-in source files named `dist-runtime.ts` or `dist-stdio-smoke.test.ts` stay in the scanned repo scope.
- **Derived-state readiness**: Stopped graph-derived startup recovery from clearing semantic summary/embedding dirty flags, and skipped semantic-only stale rows instead of enqueueing a graph refresh that cannot clear them.

_48 non-merge commits from 1 contributor since v0.11.4._

## [0.11.4] - 2026-05-21

### Added

- **symbol edit workflows**: Added first-class symbol-scoped edit preview/apply support, AST-backed edit operations, schema validation, symbol edit documentation, and integration/unit coverage for MCP and workflow use.
- **search/file edit windows**: Added plan-bound preview/source windows and fuller diff snippets for search edit plans so agents can inspect only the gated source needed for a planned edit.
- **SDL enforcement and client init**: Expanded `sdl-mcp init` enforcement asset generation for Codex/Claude-style client templates, refreshed `SDL.md`/template guidance, and added tests for generated hook/template behavior.
- **predictive prefetch policy**: Added outcome-trained predictive context policy storage, LadybugDB persistence/migration for prefetch outcomes, safe-mode suppression/boost metrics, startup prefetch wiring, and observability UI/status reporting.
- **runtime and tool diagnostics**: Added deferred runtime work state, compact/minimal runtime output paths, context raw-token baselines, tool-call token-savings telemetry, and additional status/health diagnostics.
- **specialized semantic embeddings**: Added semantic embedding model planning with `semantic.embeddingProfile`, `symbolEmbeddingModels`, and `fileSummaryEmbeddingModels`, plus tests and docs for specialized Symbol/FileSummary model lanes.

### Changed

- **semantic indexing defaults**: Default semantic indexing now uses specialized lanes: Jina for Symbol embeddings and Nomic for FileSummary embeddings; `max-recall` preserves the previous both-models-on-both-lanes behavior.
- **SDL agent workflows**: Smoothed `sdl.context`, `sdl.workflow`, action discovery, manual generation, workflow truncation, and response-handle behavior so agents get human-readable guidance and machine-useful fields without internal noise.
- **tool gateway contracts**: Updated gateway schemas, tool descriptors, compact schema tests, action catalog/manual output, and generated tool inventory to match current `sdl.file`, runtime, memory, transform, and response-handle contracts.
- **indexing and status behavior**: Let read-only status workflows bypass the foreground dispatch limiter, kept delegated indexing on the server, preserved reindex progress model metadata, and refined derived-refresh finalization.
- **documentation**: Refreshed README, SDL workflow docs/templates, configuration/reference pages, semantic docs, token-savings, runtime, search-edit, file-read, tool-gateway, and troubleshooting documentation for the new tool surfaces and operational controls.
- **release/package metadata**: Synchronized root/native/native-platform versions and lockfile entries for `0.11.4`.

### Fixed

- **config discovery**: Fixed package/repo-root config resolution so CI, tests, benchmark guardrails, and packaged defaults read `config/sdlmcp.config.json` before falling back to the global config path.
- **symbol edit stability**: Stabilized symbol edit CI expectations and AST edit handling, including coverage for schema validation and edit application paths.
- **workflow/tool friction**: Fixed multiple SDL-MCP usability issues around action search pagination, manual signatures, disabled memory action visibility, workflow response handles, transform return shapes, and file-window plan handles.
- **derived state recovery**: Re-enqueued persisted stale derived-state refresh work on server startup so one-shot CLI indexing deferrals recover when SDL-MCP next serves the repo.
- **shutdown cleanup**: Increased the graceful shutdown watchdog, bounded audit flush waits, parallelized read-connection drains, skipped final checkpoints after write-drain timeout, and named the active cleanup step in forced-exit logs.
- **LadybugDB/runtime robustness**: Hardened LadybugDB cleanup and runtime execution paths, including deferred work state, checkpoint-service behavior, and diagnostics around long-running indexing.
- **security audit cleanup**: Cleared the brace-expansion audit finding and restored build script type checking.
- **observability accuracy**: Preserved watcher/reindex progress metadata and corrected `sdl.context` token-savings reporting from returned evidence.
- **CI/test guardrails**: Updated watcher-health fixtures, config-path expectations, release lockfile coverage, and related CI cache/test checks.

### Internal

- Removed the obsolete tool-call performance investigation plan document.
- Added broad regression coverage across symbol edit, search edit, file gateway, workflow executor/parser/truncation, prefetch outcomes, config paths, runtime execution, dispatch limiting, derived refresh, shutdown, and observability.

_23 non-merge commits plus one merge commit since v0.11.3._

## [0.11.3] - 2026-05-14

### Added

- Added a dependency-free `/ui/config` visual configuration admin console with loopback-only write APIs, schema/semantic validation, redacted raw/effective snapshots, atomic save/backup/rollback, high-risk diff confirmation, and reusable JSON Pointer profiles.
- Added opt-in phase timing diagnostics for `sdl.context`, `sdl.workflow`, `sdl.runtime.execute`, and `sdl.file`, plus observability aggregation for per-tool phase p95/max latency and LadybugDB query latency sampling.
- Added `sdl.context` quality benchmark gates for lexical, confidence-gated default, and forced semantic retrieval recall, noise, and latency targets.
- Added direct CLI metadata proxies for `action.search` and `manual` (including `sdl.` aliases) without graph DB initialization; `sdl.context`, `sdl.workflow`, and `sdl.file` remain MCP-only.

### Changed

- `sdl.context` now uses confidence-gated hybrid retrieval for unscoped natural-language requests; `options.semantic: true` forces hybrid, `options.semantic: false` preserves lexical-only behavior, and exact symbol or explicit scope lookups stay on the fast path.
- Tool responses are now human-first across the MCP and CLI surfaces: visible `content`/terminal output is concise text, projected task data lives in `structuredContent`, and JSON-first consumers should switch to `structuredContent` or explicit JSON output modes.
- Stdio server startup now defers file watcher initialization until after tool serving begins, avoiding watcher/DB contention on the first tool call.
- LadybugDB stored-procedure row reads now materialize and close result handles under the per-connection mutex via a shared helper, improving latency accounting and avoiding leaked live query results.
- Operator docs now distinguish foreground tool dispatch queue timeouts from background derived-refresh timeouts and document `SDL_DERIVED_REFRESH_TIMEOUT_MS`.

### Fixed

- Bounded LadybugDB FTS retrieval by passing `TOP` separately from BM25 `K` in `QUERY_FTS_INDEX` calls.
- SDL-MCP tool responses now include visible MCP content blocks for human-readable tool output, edit diff previews, and per-call token-savings meters instead of relying only on optional client logging notifications.
- MCP content now defaults to model-facing projections that omit internal task IDs, cache/debug diagnostics, precondition snapshots, backup paths, live-index details, packed-wire stats, and duplicate `sdl.context` summaries unless the caller explicitly requests diagnostic surfaces; ETags remain visible for conditional follow-up calls.
- `file.write` and `search.edit apply` responses now surface bounded before/after diff previews in visible tool output, matching `search.edit preview` behavior.

## [0.11.2] - 2026-05-11

### Added

- Semantic enrichment bridge V1 with provider-neutral config/types, SCIP > LSP source selection, explicit refresh/status actions, lightweight stdio LSP client support, and LadybugDB provider-run/provenance/precision tables.
- Semantic enrichment V2 TypeScript/JavaScript LSP call-definition enrichment that plans tree-sitter call candidates, queries configured stdio LSP servers, and writes exact call edges through the generic semantic writer.
- Generic LSP-native diagnostic ingestion for configured stdio servers without SDL-MCP tree-sitter adapters, plus optional LSP metadata hints (`documentLanguageIds`, `filePatterns`, `capabilities`, `readiness`) in config.
- Handle-backed large response storage with `response.get` retrieval and opt-in `responseMode` support for `sdl.context`, `file.read`, `code.needWindow`, and `search.edit` preview responses.
- Session-aware `deltaMode` support for repeated `file.read` and `code.needWindow` windows, plus observability token-savings breakdowns by compression layer and tool.
- Experimental opt-in `sdl.context` `evidenceOptimization` modes: `dedupe` removes exact duplicate/subsumed ladder evidence, `budgeted` greedily selects evidence by value per token under `budget.maxTokens` while preserving matching cards for selected hot paths, and `global` optimizes broad-mode `summary`, `answer`, and `finalEvidence` together under the response budget.
- Direct CLI access to the `file.write` action through `sdl-mcp tool file.write`, including targeted write-mode flags and stdin JSON support for complex payloads.
- `sdl.file` now exposes plan-bound `previewWindow`/`sourceWindow` operations that validate search-edit plan handles and delegate indexed source access through `code.needWindow` policy.

### Changed

- Removed LSIF semantic enrichment support before stabilization; source selection is now SCIP > LSP, with historical LSIF provider-run rows still readable.
- `search.edit` previews now return diff-anchored, line-numbered hunk snippets with explicit before/after line ranges for each file entry.
- `sdl.scip.ingest` help/schema now describes SCIP `.scip` input only; LSP enrichment runs through the semantic enrichment bridge instead of the SCIP compatibility action.
- LSP semantic enrichment no longer hard-rejects non-TypeScript languages; configured servers are selected by advertised provider availability and runtime LSP capabilities.

### Fixed

- HTTP serve shutdown now closes active Streamable HTTP session transports before final LadybugDB/log cleanup, preventing long-lived stream sessions from keeping Ctrl+C shutdown stuck.
- LSP semantic enrichment now launches Windows `.cmd`/`.bat` server shims through `cmd.exe` so installer-managed language servers can run from their recorded command paths without Node shell-argument deprecation warnings.
- Resolved CI security audit failures by refreshing the transitive `fast-uri`
  lockfile entry to the patched 3.1.2 release.
- Restored `search.edit` to the direct CLI tool-action surface so the CLI
  catalog stays in sync with the gateway action catalog.
- Stabilized Windows CI by giving the pass-2 concurrency integration test a
  larger isolated LadybugDB write-queue budget and by scoping benchmark repo
  caches per runner OS.
- Observability token-savings reporting now records packed-wire token totals
  alongside byte totals, counts only realized packed emissions as savings, and
  measures `sdl.context` usage against the projected response payload that
  clients receive instead of stripped internal broad-context fields.
- Response artifacts now honor runtime artifact byte caps, sweep expired
  handles before writes, and avoid cross-client session-delta reuse when a
  transport session id is unavailable.
- Serve-mode LadybugDB WAL maintenance now performs best-effort idle
  checkpoints when the WAL is quiet/large or old, while skipping active
  indexing and post-index sessions.
- Tool-call audit logging now stores compact request/response summaries
  instead of full payload bodies by default, reducing WAL churn from read-heavy
  MCP usage.
- npm postinstall now verifies and rebuilds tree-sitter grammar bindings before
  pruning source files, and release publish CI blocks npm publish until a
  packed-tarball install verifies those grammars on Ubuntu and Windows.

## [0.11.1] - 2026-05-07

### Added

- **Per-repo post-index timeout config.** `repos[].postIndexSessionTimeoutMs`
  now controls the post-index write-session timeout for each repository,
  preserving the 900000ms default while letting larger repos raise the budget
  without changing code or process-wide environment variables.

### Changed

### Fixed

## [0.11.0] - 2026-05-07

### Performance

- **Pass-2 read amplification eliminated (A1).** Each language resolver
  previously did `getFileByRepoPath` per imported module + `getSymbolsByFile`
  per resolved target file — ~30k point reads per refresh on a 1000-file TS
  repo. New pass-level `Pass2ImportCache` (in `src/indexer/pass2/types.ts`)
  populated once at dispatcher start with two batched reads
  (`getFilesByRepo` + new `getExportedSymbolsLiteByFileIds`); resolvers do
  O(1) map lookups instead. Threaded through `resolveImportTargets` (now
  takes optional `cache` arg) and the cpp/c/shell helper indexes that wrap
  it. Eliminates ~30k point-read round trips per pass-2.
- **Pass-2 re-parse eliminated for TS files (C1).** Pass-1 already
  parses every file with tree-sitter; pass-2 was redundantly re-parsing on
  the JS main thread. New `Pass1ExtractionCache` (`Map<relPath,
Pass1ExtractionEntry>`) populated during pass-1 from both engines
  (`process-file.ts` for the TS engine, `rust-process-file.ts` for the Rust
  engine), gated on `isTsCallResolutionFile + skipCallResolution`. The TS
  resolver in `edge-builder/pass2.ts` checks the cache first; on hit,
  skips a full tree-sitter parse + three `extract*` calls. Other-language
  resolvers retain inline re-parse because their resolvers consume the live
  tree handle for scope walkers / call-scope indexes. ~30-50% of pass-2
  wall on TS-heavy repos.
- **Pass-2 write coalescing per concurrency batch.** New `submitEdgeWrite`
  callback in `Pass2ResolverContext` lets the dispatcher decide between
  immediate flush (sequential path, one `withWriteConn` per file) and
  batched flush (parallel path, one `withWriteConn` per concurrency batch
  with combined delete + insert). All 11 language resolvers refactored:
  removed `clearOutgoingCallEdges` SQL helper, replaced with in-memory
  `clearLocalCallDedupKeys`; replaced 2× `withWriteConn` per file with 1×
  `submitEdgeWrite` callback. Cuts writeLimiter handshakes from
  O(filesPerBatch) to 1.
- **Pass-2 concurrency raised on high-end tiers (F1).** `cpu-presets.ts`:
  extreme tier `pass2Concurrency 6 → 12`, high tier `3 → 8`. Unblocked by
  C1 — earlier raises were capped by the JS main-thread re-parse
  bottleneck.
- **Embedding write coalescing on rebuild path.** When `dropVectorIndex`
  succeeds (no live HNSW to maintain), `refreshSymbolEmbeddings` accumulates
  ONNX batch results into a 256-item buffer and flushes via a single
  `withWriteConn` instead of one per ONNX batch. Cuts writeLimiter
  handshakes ~8× on bulk rebuild. Buffer is force-flushed in `finally`
  before the HNSW rebuild so unflushed vectors can't strand outside the
  index.
- **`BatchPersistAccumulator` flush threshold raised 200 → 512.** Better
  fills the underlying UNWIND CHUNK=256 window in batched writes; halves
  txn boundaries on pass-1 drain. Memory cost per accumulator ~+200KB.

### Added

- **Codex SDL-first tool enforcement.** `sdl-mcp init --client codex
--enforce-agent-tools` now emits a broad `PreToolUse` hook that is gated
  by the SDL-MCP PID file. When the server is running, the hook denies
  repo-targeting native source reads/searches/edits, non-SDL MCP file/search
  tools, and repo-local build/test/lint shell commands that should run through
  SDL-MCP. When the PID file is absent, native tools remain available.
- **`semantic.modelVariant` config.** Selects the ONNX file variant
  (`default`/`int8`, `fp16`, `fp32`, plus nomic-only `uint8`/`q4`/
  `q4f16`/`bnb4`) per embedding model. Each model declares supported
  variants in `src/indexer/model-registry.ts`; unsupported requests fall
  back to that model's `defaultVariant` with a warning. Lets users trade
  speed for accuracy without a code change.
- **`semantic.executionProviders` config.** Configurable ONNX Runtime
  execution provider list. Platform allow-list filtered against the default
  `onnxruntime-node` package: Windows x64 `["cpu", "dml", "webgpu"]`,
  macOS `["cpu", "coreml"]`, Linux x64 `["cpu", "cuda", "tensorrt"]`,
  Linux arm64 `["cpu"]`. Unsupported entries dropped with a warning;
  `"cpu"` auto-appended as final fallback. Enables AMD GPU acceleration
  on Windows via DirectML, Apple Silicon ANE/GPU via CoreML, NVIDIA on
  Linux via CUDA (system CUDA 12 + cuDNN required).
- **`semantic.embeddingsSequential` config.** Run multiple embedding
  models in series instead of via `Promise.all`. Default `false`. Set
  `true` on systems where ORT serializes parallel sessions at the
  thread-pool layer (alternation pattern in CLI progress). Each model
  then holds the full thread budget end-to-end.
- **`semantic.embeddingBatchSize` config.** ONNX inference batch width
  for symbol embedding refresh. Default 32, max 128. Larger batches
  amortise tokenizer + session bind/unbind costs.
- **`MAX_EMBEDDING_CONCURRENCY` raised 4 → 8.** Schema cap and clamp logic
  bumped; users can now request `embeddingConcurrency` up to 8.
- **`scip.generator.cleanupAfterIngest` config.** Default `true`. Deletes
  `<repoRoot>/index.scip` after the post-refresh ingest consumes it so the
  generated file doesn't clutter the working tree. Skipped automatically
  when `args` contains `--output`/`-o` (custom paths are user-managed).
- **Per-model embedding progress in CLI.** `IndexProgress.model?: string`
  tags embedding events with their source model. CLI renderer keeps a
  per-model `Map` and renders both jina + nomic on a single status line
  (e.g. `Embeddings: jina [###---] 25% (2100/8522) | nomic [####--] 30% (2500/8522)`)
  instead of letting interleaved events overwrite each other's counts.
- **Pass-1 drain progress feedback.** `BatchPersistAccumulator` accepts an
  optional `setProgressCallback` invoked after each batch flush.
  `indexer-pass1.ts` wires this to emit `finalizing/pass1Drain` substage
  events with `stageCurrent`/`stageTotal`, replacing the static
  "Flushing pass 1 writes" label with a live progress bar.
- **Pass-2 import + extraction cache types.** `Pass2ImportCache`,
  `Pass1ExtractionCache`, `Pass1ExtractionEntry`, and `SubmitEdgeWrite`
  exported from `src/indexer/pass2/types.ts`.
- **`getExportedSymbolsLiteByFileIds` query.** New batched read in
  `src/db/ladybug-symbols.ts` returning `Map<fileId, ExportedSymbolLite[]>`
  (just `symbolId`, `name`). Drop-in replacement for per-file
  `getSymbolsByFile().filter(s => s.exported)` in import resolution.

### Changed

- **MCP TypeScript SDK updated to 1.29.0.** Keeps the monolithic
  `@modelcontextprotocol/sdk` dependency on the latest v1 release line.
- **FileSummary embedding refresh stats are stricter.** Incremental
  refreshes only evaluate the requested file IDs; cache hits count as
  `skipped`, while empty file-level payloads now count as `missing`.
- **`durationMs` in `IndexResult` now reflects full wall-clock.**
  Previously captured immediately after the `versionSnapshot` phase, which
  silently excluded the entire post-index session (finalizeIndexing,
  embeddings, deferred indexes, audit flush). On full-mode runs with
  embeddings this could under-report by 200-400+ seconds. Now matches
  `timings.totalMs`.
- **`MAX_EMBEDDING_CONCURRENCY` is 8** (was 4). Schema clamps + tests
  updated. `embeddingConcurrency` accepts 1-8.
- **`MAX_EMBEDDING_BATCH_SIZE` and `DEFAULT_EMBEDDING_BATCH_SIZE`.** New
  constants (128 and 32 respectively). `REFRESH_BATCH_SIZE` kept as an
  exported alias for `DEFAULT_EMBEDDING_BATCH_SIZE` so tests / scripts
  retain a stable reference.
- **Model registry restructured around variants.** `ModelInfo` now exposes
  `defaultVariant` + `variants: Record<string, ModelVariantInfo>` instead
  of a flat `modelFile` + `downloadUrls.model`. Tokenizer/config URLs
  remain shared across variants. New `resolveVariant(name, requested?)`
  helper centralises fallback logic. `resolveModelPath`,
  `isModelAvailable`, and `ensureModelAvailable` now accept an optional
  `variant` argument.
- **Pass-2 dispatcher writes per batch, not per file.** Parallel-path
  `runPass2Resolvers` now collects edges from every file in a
  concurrency-batch into a `BatchWriteAccumulator` and issues one combined
  `withWriteConn(delete-then-insert)` after `Promise.all` settles.

### Fixed

- **SDL-MCP tool friction fixes.** `sdl.manual` now omits disabled memory
  actions when memory is off; Zod v4 discriminated-union schemas such as
  `search.edit` now produce useful schema summaries; `search.edit` preview
  suppresses normal include/exclude filter misses and caps skipped-file /
  retrieval diagnostics; `slice.build` accepts `wireFormat: "json"` as a
  standard JSON alias; `sdl.context` auto mode no longer ships duplicate
  `_packedPayload`; exact identifier `symbol.search` calls stay on the
  lexical fast path unless semantic/PPR context is explicitly requested;
  `sdl.workflow.truncated` only marks actually skipped/truncated responses;
  and `sdl.file` JSON/YAML path reads parse the full supported file while
  applying `maxBytes` to the returned extraction.
- **Second-pass tool friction fixes.** Literal `search.edit` include filters
  now resolve directly without semantic narrowing or unrelated repo walks;
  `sdl.context` treats exact code identifiers as deterministic seed symbols
  before broad retrieval, accepts `budget.maxEstimatedTokens` as a
  `maxTokens` alias, and rejects unsupported `budget.maxCards` clearly;
  `$0.results.0.symbolId` workflow refs are now supported; `search.edit`
  action summaries merge `mode` variants as `preview|apply`; context packed
  stats now distinguish candidate savings from returned payload format; and
  MCP responses no longer return a duplicate footer text block.
- **Published package now includes `templates/SDL.md`.** Fixed
  `sdl-mcp init --client <client>` failing from npm/global installs with
  `ENOENT: templates\SDL.md`; release preflight now requires all client init
  templates in the packed tarball.
- **`dropVectorIndex` regex now matches LadybugDB binder errors.** The
  `/does not exist/i` check missed LadybugDB's actual phrasing
  (`"Binder exception: Table X doesn't have an index with name Y."`),
  causing fresh-DB embedding refreshes to take the slow per-row HNSW
  maintenance path AND skip the post-write index rebuild — leaving the DB
  without a vector index after every fresh-DB run. Regex broadened to
  `/does not exist|doesn't have an index with name|no such (vector |fts )?index/i`.
  The `indexes.length > 0` guard on `showIndexes` verification was also
  dropped; the binder error itself is authoritative for "this index
  doesn't exist on this table".

### Changed

- **`HealthMetrics.engineDispatch` semantics: events → files (BREAKING).**
  Previously incremented per `index.refresh` event (one tick per run);
  now reflects per-file dispatch sourced from `IndexStats.pass1Engine.{rustFiles,tsFiles}`.
  Legacy `+= 1` per-event behavior preserved as a back-compat fallback when
  `pass1Engine` telemetry is absent. Dashboard ratios + REST snapshot consumers
  should expect order-of-magnitude larger counts. Surfaces in
  `/api/observability/snapshot` and SSE stream.

- **Packed wire format default flipped to `"auto"`** for `slice.build`,
  `sdl.symbol.search`, and `sdl.context`. Server now runs the packed gate by
  default; clients without a packed decoder must opt back to legacy with
  `wireFormat: "compact"` (slice) or `wireFormat: "json"` (symbol/context),
  or set `wire.packed.defaultFormat: "compact"` in config. Decoder available
  via `decodePacked` from `@sdl-mcp/wire/packed`.
- **Packed gate thresholds lowered**: byte threshold `0.15 → 0.10`, token
  threshold `0.30 → 0.20`. More responses now clear the gate; admins can
  override via `wire.packed.threshold` / `wire.packed.tokenThreshold` or env
  `SDL_PACKED_THRESHOLD` / `SDL_PACKED_TOKEN_THRESHOLD`.

### Added

- **Packed wire-format coverage extended to `sdl.symbol.search` and
  `sdl.context`** — both tools now run the packed gate end-to-end with tap
  events for both `packed` and `fallback` decisions. Observability dashboard
  PACKED / BYTES SAVED counters increment for `ss1` (symbol-search) and
  `ctx1` (context) encoders, not just `sl1`. Per-encoder breakdown table
  added to the token-efficiency panel.
- **Per-encoder dashboard breakdown** in `PackedWireMetrics.byEncoder`:
  totalDecisions, packedCount, fallbackCount, packedAdoptionPct,
  jsonBaselineBytesTotal, packedBytesTotal, bytesSaved, bytesSavedRatio.
  Surfaces in `/ui/observability` token-efficiency panel.
- **Slice fallback tap publishing** — `slice.build` previously only published
  packed-decision tap events; fallbacks were silent. Both branches now record
  to `tokenAccumulator` and publish `packedWire` tap events.

### Removed

- **`gen1` generic packed encoder** — never wired into any production tool
  path. Removed `encodeGeneric` / `decodeGeneric` exports, registry entry,
  and `tests/unit/packed-generic.test.ts`. `EncoderId` type narrowed to
  `"sl1" | "ss1" | "ctx1"`.

### Added

- **Observability dashboard (V1, read-only)** — built-in HTTP UI at
  `/ui/observability` plus
  `/api/observability/{snapshot,timeseries,beam-explain,stream}` REST + SSE APIs.
  Surfaces cache hit rates, hybrid retrieval breakdowns (FTS / vector / PPR /
  RRF), beam-search decision traces, indexing pipeline metrics, write-pool /
  drain saturation, packed-wire savings, SCIP ingest health, deterministic
  bottleneck classification, and OS-level resource samples. Configurable via
  the new `observability.*` config block (`enabled`, `sampleIntervalMs`,
  `retentionShortMinutes`, `retentionLongHours`, `pprMetricsEnabled`,
  `packedStatsEnabled`, `scipIngestMetrics`, `beamExplainCapacity`,
  `beamExplainEntriesPerSlice`, `sseHeartbeatMs`). Default sampling interval
  2 s; 15-minute short window + 24-hour long window. Bearer-auth gated
  identically to other `/api/*` routes. New deep dive at
  [`docs/feature-deep-dives/observability-dashboard.md`](docs/feature-deep-dives/observability-dashboard.md).

## [0.10.10] - 2026-04-28

### Fixed

- **`sdl-mcp init` now respects `CLAUDE_CONFIG_DIR` and resolves the home
  directory cross-platform.** `detectInstalledClients` previously used the
  Windows-only `process.env.USERPROFILE`, so detection on macOS/Linux
  silently produced CWD-relative garbage paths and never matched anything;
  it also ignored `CLAUDE_CONFIG_DIR`, so install instructions always
  pointed at `~/.claude` even when the user had redirected it. Falls back
  to `os.homedir()` when `USERPROFILE` is unset and honors
  `CLAUDE_CONFIG_DIR`. (#17)
- **Concurrent `serve --stdio` no longer corrupts the LadybugDB WAL.** Two
  processes starting simultaneously (e.g. two Claude Code windows) could
  both open the WAL before the pidfile singleton guard fired, corrupting
  it on the next checkpoint. Both call sites (`src/main.ts` and
  `src/cli/commands/serve.ts`) now resolve the graph DB path, run
  `findExistingProcess`, and `writePidfile` to atomically claim the
  singleton _before_ `initGraphDb`. `writePidfile` additionally writes
  with `flag: "wx"` and recovers from `EEXIST` by re-reading the file,
  closing the check-then-write TOCTOU window if call-site ordering ever
  regresses. (#19)
- **Pidfile is removed when startup fails.** Code-review follow-up to the
  WAL race fix: after reordering `writePidfile` ahead of `initGraphDb`,
  startup throwing later (initGraphDb, watcher start, etc.) left the
  pidfile on disk because the `catch` handlers in `main.ts` and `serve.ts`
  exit without invoking `shutdownMgr.shutdown()`. `pidfilePath` is now
  hoisted so the catch handler can `removePidfile()` on failure,
  eliminating the operator-confusion + PID-reuse window. (#19)

### Token-aware gate

- **Two-axis auto-gate** for `packed` emission. The dispatcher now emits
  packed when EITHER byte savings clear `wire.packed.threshold` (default
  0.15) OR estimated-token savings clear `wire.packed.tokenThreshold`
  (default 0.30). Tokens are the dominant axis on slice-shaped LLM
  payloads — empirically 40–54% saved across 8 representative live slices
  (6–60 cards), versus 5–23% byte savings. Pre-tune, only 1/8 fixtures
  cleared the byte gate; post-tune, 8/8 emit packed. New env var
  `SDL_PACKED_TOKEN_THRESHOLD` overrides the token axis.
- New `decideFormatDetailed(wireFormat, metrics, byteThreshold,
tokenThreshold)` returns `{ decision, axisHit, bytesSavedRatio,
tokensSavedRatio }`. Legacy single-axis `decideFormat` and
  `shouldEmitPacked` retained for back-compat.
- `_packedStats` response field gains `jsonTokens`, `packedTokens`,
  `tokenSavedRatio`, `axisHit` (`"bytes"` | `"tokens"`).
- New optional dispatcher option `packedTokenThreshold` parallels
  `packedThreshold`.

### Added — `packed` wire format

- **New `wireFormat: "packed"` and `"auto"` for `sdl.slice.build`, plus optional
  `wireFormat` on `sdl.symbol.search` and `sdl.context`.** Line-oriented
  text format with `#PACKED/1` header, legend-interned path prefixes, single-char
  tagged CSV tables, and `__tables` / `__stypes` self-describing schema. Median
  ~45% byte savings vs JSON across slice-shaped responses; gate-protected to
  fall back to compact-JSON below the 0.15 savings threshold (configurable).
  Encoders ship as `sl1` (slice), `ss1` (symbol-search), `ctx1` (context),
  `gen1` (generic fallback). Schema-free decoder (`decodePacked`) reads
  `__tables` / `__stypes` so new encoders ship without bumping the decoder
  version. Header is intentionally `#PACKED/1` (not `#MUNCH/1`) to namespace
  cleanly from the upstream jcodemunch-mcp dialect.
- **Telemetry**: new `wire.packed` section in `sdl.usage.stats` reports
  `encodings`, `fallbacks`, `bytesSaved`, and per-encoder breakdown.
  Migration `m014` adds `packedEncodings`, `packedFallbacks`,
  `packedBytesSaved`, `packedByEncoderJson` columns to `UsageSnapshot`.
- **Config**: new `wire.packed.{enabled,threshold,defaultFormat,encoders}`
  block under `AppConfigSchema`. Env vars `SDL_PACKED_ENABLED`,
  `SDL_PACKED_THRESHOLD`, `SDL_PACKED_DEFAULT_FORMAT` override config.
- New `estimatePackedTokens(text)` in `src/util/tokenize.ts` (length / 3.2).
- New agent helper `unpackWireResult(result)` /
  `tryUnpackPayload(payload)` in `src/agent/wire-utils.ts`.

### Breaking Changes

- **Compact wire format versions 1 and 2 retired.** Calling
  `sdl.slice.build` with `wireFormatVersion: 1` or `2` now throws
  `WireFormatRetiredError` (code `WIRE_FORMAT_RETIRED`) at runtime.
  **Migration**: replace `wireFormatVersion: 1` or `2` with
  `wireFormatVersion: 3` (the default since v0.7.x), or opt in to
  `wireFormat: "packed"` for the new line-oriented format.
- Deleted: `toCompactGraphSliceV1`, `toCompactGraphSliceV2`,
  `decodeCompactGraphSliceV3ToV2`, `decodeCompactEdgesV2ToV1`,
  `decodeCompactEdgesV3ToV1`, `CompactGraphSlice` (v1 alias),
  `CompactGraphSliceV2` type aliases. The downgrade decoders are gone
  because the encoders that fed them are gone.
- `serializeSliceForWireFormat()` now returns a discriminated
  `WireFormatResult` union (`{format, payload, ...}`) instead of a raw
  payload object. Direct callers in user-side code must read `.payload`.
- `SliceBuildResponse.slice` schema gained `z.string()` to admit packed
  payloads.

## [0.10.9] - 2026-04-27

### Added

- **Chat-aware Personalized PageRank re-ranking on `sdl.symbol.search` and `sdl.context`.**
  Callers can pass `chatMentions: string[]` (plus optional `chatMentionWeights`,
  `pprDirection`, `pprWeight`) to bias result ranking toward symbols structurally
  close to what the user just talked about. Resolves mentions to symbols (full
  hex ID / shortId prefix / bare name), runs Andersen-Chung-Lang forward-push PPR
  over `DEPENDS_ON` from those seeds, and applies a multiplicative boost to the
  fused RRF list. Native Rust impl via `compute_personalized_pagerank` napi
  export with a JS push fallback (parity within 1e-3). Composition cap 4× over
  the original RRF score keeps stacked boosts (feedback + PPR) bounded.
  - New: [src/retrieval/ppr.ts](src/retrieval/ppr.ts), [src/retrieval/seed-resolver.ts](src/retrieval/seed-resolver.ts), [native/src/pagerank/](native/src/pagerank/)
  - Default `pprWeight = 2.0` tuned via 20-query sweep — see
    [devdocs/ppr-weight-tune-results.md](devdocs/ppr-weight-tune-results.md):
    85% NDCG@10 lift over RRF baseline on near-target mentions, zero effect on
    irrelevant or empty mention sets, no recall regression, ~5ms PPR overhead.
  - Bench harness: `npm run bench:ppr` ([scripts/bench-ppr-weight.ts](scripts/bench-ppr-weight.ts))
    against [tests/fixtures/ppr-tune/queries.json](tests/fixtures/ppr-tune/queries.json).
  - Deep dive: [docs/feature-deep-dives/semantic-engine.md → Chat-Aware PageRank Boost](docs/feature-deep-dives/semantic-engine.md#chat-aware-personalized-pagerank-boost-v0109).
  - **Auto-extract chatMentions**: when caller passes `chatMentions: undefined`,
    the server extracts identifier-like tokens from `query` (`sdl.symbol.search`)
    or `taskText` (`sdl.context`) via `autoExtractMentions` and uses those as
    PPR seeds. Pass an explicit empty array `[]` to disable PPR for the call.
  - **`pprBoosts` evidence surface**: `SymbolSearchResponse.pprBoosts` exposes
    `{ resolvedSeeds, unresolvedMentions, ambiguousMentions, symbolsBoosted,
latencyMs, backend }` when `includeRetrievalEvidence: true` and PPR ran.
  - **Bench CI flags**: `npm run bench:ppr -- --baseline tune-baseline.json`
    fails with exit code 1 if the current winner regresses by >2% NDCG vs. a
    checked-in baseline; `--holdout N` splits the fixture into train + holdout
    and reports cross-validation drift.

### Changed

- **`sdl.symbol.search` defaults to hybrid retrieval** (FTS + vector + RRF)
  unless the caller explicitly passes `semantic: false`. Previously
  `semantic: undefined` skipped the hybrid path; now only an explicit opt-out
  bypasses it, matching `sdl.context`'s default-on behavior since v0.10.7.
- **Internal module split to reduce per-file surface area** (no behavior change):
  - `src/graph/slice.ts` (was ~700 LoC) split into
    [`slice/beam-search-engine.ts`](src/graph/slice/beam-search-engine.ts),
    [`slice/card-hydrator.ts`](src/graph/slice/card-hydrator.ts),
    [`slice/detail-level.ts`](src/graph/slice/detail-level.ts),
    [`slice/edge-projector.ts`](src/graph/slice/edge-projector.ts), and
    [`slice/types.ts`](src/graph/slice/types.ts).
  - `src/agent/executor.ts` identifier-extraction helpers extracted to
    [`src/agent/identifier-extraction.ts`](src/agent/identifier-extraction.ts).
  - `src/retrieval/orchestrator.ts` fusion math extracted to
    [`src/retrieval/fusion.ts`](src/retrieval/fusion.ts).
  - Refactor scripts under `scripts/refactor-extract-*.mjs` are reproducible.

### Performance

- **Embedding refresh: batched DB writes per model batch.** Previously each
  symbol got its own `withWriteConn → setSymbolEmbeddingOnNode` call (~8K
  lock acquisitions per model on a full index). Added
  `setSymbolEmbeddingBatchOnNode` in
  [src/db/ladybug-symbol-embeddings.ts](src/db/ladybug-symbol-embeddings.ts)
  that processes the whole batch inside one write connection, reusing
  resolved property names and a shared timestamp.
  [src/indexer/embeddings.ts](src/indexer/embeddings.ts) `processBatch` now
  issues a single `withWriteConn` per batch and skips the post-embed cache
  recheck (no concurrent embedding writer exists during indexing). Cuts
  write-lock acquisitions ~97% (N → N/32 at batch size 32); expected
  ~60–70% reduction in embedding-phase wall time.

## [0.10.8] - 2026-04-23

### Added

- **Grammar-wrapper packages to silence `ERESOLVE` peer warnings on install.**
  sdl-mcp consumes 11 upstream tree-sitter grammars whose `peerOptional
tree-sitter` ranges cap at `^0.25.0` — narrower than the `@keqingmoe/tree-sitter@0.26.2`
  alias sdl-mcp needs for Node 24 / C++20 compatibility. Published 11 thin
  `sdl-mcp-tree-sitter-*` wrapper packages that bundle each upstream grammar
  and declare a permissive `tree-sitter: >=0.21.0` peer range. [sdl-mcp/package.json](package.json)
  now aliases each grammar dep (e.g. `"tree-sitter-c": "npm:sdl-mcp-tree-sitter-c@^1.0.0"`)
  so `grammarLoader.ts` requires resolve to the wrappers with no code change.
  Consumer install output drops from ~10 `ERESOLVE overriding peer dependency`
  warnings to 0. Upstream grammar native bindings ship transitively via
  `bundleDependencies`, so no extra compilation happens at consumer install.
  - New tree: `grammar-wrappers/sdl-mcp-tree-sitter-{bash,c,c-sharp,cpp,go,java,kotlin,php,python,rust,typescript}/`
  - New script: [scripts/scaffold-grammar-wrappers.mjs](scripts/scaffold-grammar-wrappers.mjs)
    (idempotent wrapper regenerator; bump upstream pins here)
  - New drift guard: [tests/unit/grammar-wrapper-manifest.test.ts](tests/unit/grammar-wrapper-manifest.test.ts)
    and `findGrammarWrapperAliasDrift()` in [scripts/prepare-release.mjs](scripts/prepare-release.mjs)
  - New CI workflow: [.github/workflows/publish-grammar-wrappers.yml](.github/workflows/publish-grammar-wrappers.yml)
    (manual dispatch, supports `dry_run` / `only_wrapper` / `dist_tag` inputs)
  - New doc: [grammar-wrappers/README.md](grammar-wrappers/README.md) — rationale,
    version matrix, upgrade procedure, and CJS/ESM pin caveat for `tree-sitter-c-sharp`
- **`sdl.search.edit` cross-file search/edit tool** (two-phase `preview` +
  `apply`). Preview returns a server-side `planHandle` plus per-file
  snippets, match counts, and a sha256/mtime precondition snapshot.
  Apply re-verifies preconditions, writes sequentially in deterministic
  path order, rolls back already-written files on mid-batch failure,
  and surfaces per-file `indexUpdate` for indexed source. Plan handles
  are in-memory with a 15-minute TTL and LRU cap of 16 per process.
  Closes the cross-file mutation gap where agents previously composed
  `symbol.search` → `file.read` → `file.write` by hand.
  - New module tree: `src/mcp/tools/search-edit/{planner,plan-store,batch-executor,index}.ts`
  - New doc: `docs/search-edit-tool.md`
- **`search.edit` text-mode uses hybrid retrieval to narrow candidates**:
  text-mode previews with a `literal` query (≥3 chars) now seed the
  candidate file list via `narrowFilesForQuery` (entity-level FTS +
  vector + RRF), falling back to full directory enumeration when hybrid
  retrieval returns nothing or is unavailable. The planner surfaces a
  `retrievalEvidence` field on `SearchEditPreviewResponse` carrying the
  same shape (`sources`, `topRanksPerSource`, `candidateCountPerSource`,
  `fusionLatencyMs`, `fallbackReason`) that `sdl.context` emits.
- **`narrowFilesForQuery` in `src/retrieval/orchestrator.ts`**: exported
  entry point used by the `search.edit` planner. Resolves hybrid-search
  symbol hits back to their owning files and returns both the candidate
  paths and the retrieval evidence. Degrades gracefully to `paths: []`
  when the DB or retrieval backends are unavailable.
- **Unit + property tests for `search.edit`**:
  - `tests/unit/search-edit-plan-store.test.ts` — TTL, LRU eviction,
    remove/clear, unique handles
  - `tests/unit/search-edit-batch-executor.test.ts` — precondition
    drift detection, deterministic apply order, mid-batch rollback
  - `tests/unit/search-edit-narrow.test.ts` — graceful fallback paths
    for `narrowFilesForQuery`
  - `tests/property/search-edit-properties.test.ts` — apply+revert
    identity over N files, backup invariants

### Changed

- **`file.write` refactored into thin handler + shared internals**
  (`src/mcp/tools/file-write-internals.ts`). No behavior change to
  `file.write`; the new internals are reused by `search.edit`'s batch
  executor to share path validation, backup, mode dispatch, and
  live-index sync.
- **`file.write` action description clarified** — previously "Write to
  non-indexed files". Now documents that both indexed and non-indexed
  single-file writes are supported, and cross-references `search.edit`
  as the multi-file path.

### Fixed

- **CLI incremental indexing now returns to the prompt**: one-shot
  `sdl-mcp index` runs suppress deferred derived-state background refresh,
  shut down any queued refresh work, close LadybugDB resources, and explicitly
  exit after successful indexing. The legacy `scripts/index-repo.ts` helper now
  performs the same cleanup.
- **Code Mode CI regressions**: `dataFilter` now handles the `in` operator as
  array membership instead of falling into `icontains`, and exclusive Code Mode
  tests/docs now include the unified `sdl.file` surface.

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
