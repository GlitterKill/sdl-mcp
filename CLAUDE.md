# Tool Usage Rules - SDL-MCP Enforcement

Use SDL-MCP as the default path for repository `sdl-mcp`.

> Token-lean agent playbook — decision ladder, budget patterns, `sdl.file` workflow, anti-patterns — see [SDL.md](./SDL.md).

## SDL-MCP Skill Bootstrap

At the start of every new session in this repository, load and follow the `sdl-mcp-agent-workflow` skill before repository exploration, command execution, or edits. The Codex `SessionStart` hook also auto-loads the lean skill body as a system message; treat the hook-loaded skill as authoritative over these fallback notes.

Skill path for this workstation: `C:\Users\glitt\.codex\skills\sdl-mcp-agent-workflow\SKILL.md`.

If the skill is unavailable, fall back to [SDL.md](./SDL.md): start with `repo.status`, gather task context with `sdl.context`, escalate through `sdl.workflow`, and use SDL runtime for repo-local commands.

## Conditional Enforcement

All SDL-MCP enforcement is **conditional** on the server being active (PID file exists).
When SDL-MCP is not running, all native tools (Read, Bash, Explore) work normally with no restrictions.
When the PID file is present, repo-local native shell and file tools are fallback-only. Use SDL-MCP runtime for shell actions, the Iris ladder for indexed reads, `symbol.edit` for one-symbol indexed writes, `searchEditPreview` with `targeting:"identifier"`/`"structural"` or `operations[]` for cross-file indexed edits, and `file.read`/`file.write` for non-indexed files. Native access remains allowed for `.codex/**`, `.claude/**`, and non-repo agent skills, memories, and session internals.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SDL-MCP** (Symbol Delta Ledger MCP Server) is a Model Context Protocol server for TypeScript/JavaScript repositories with Windows-first development. It replaces bulk code context with:

- **Symbol Cards**: Stable, compact metadata for functions/classes/interfaces
- **Graph Slices**: Task-scoped dependency subgraphs (cards-first, not raw code)
- **Delta Packs**: Change tracking between ledger versions with blast radius computation
- **Proof-of-Need Code Windows**: Gated raw code retrieval requiring justification

## Current State

**Version**: 0.11.7

Indexed: 1,272 files, ~25.1K symbols, ~12.5K edges (per latest `repo.status` / `repo.overview`).

The implementation is **fully complete** in this repository with:
- TypeScript source (~105K lines) + tests (~79K lines)
- Rust native addon (~52K lines) via napi-rs
- MCP tool gateway surfaces, internal workflow transforms, and opt-in memory actions documented by the generated tool inventory (counts intentionally not duplicated in narrative docs)
- 11 language adapters (TS, Python, Go, Java, Rust, C#, C++, C, Kotlin, PHP, Shell)
- 13 CLI commands (init, doctor, info, index, serve, version, benchmark:ci, export, import, pull, health, summary, tool)
- LadybugDB graph backend (idempotent schema; no SQL migrations required)
- SCIP integration for compiler-grade cross-references (auto-ingests on `index.refresh` when configured)
- Hybrid retrieval (FTS + vector + RRF) on by default in `sdl.context` and `sdl.symbol.search`
- Development memories with graph-backed persistence and file sync (opt-in)
- Cluster/community detection + process call-chain tracing (Rust addon when available; TS fallback)
- ONNX embeddings (unbundled): all-MiniLM-L6-v2 (bundled), nomic-embed-text-v1.5, jina-embeddings-v2-base-code (fetched postinstall)
- Full test infrastructure (unit, integration, golden, property, stress, mutation)
- GitHub Actions CI/CD (ubuntu + windows matrix, Node 24.x)

## Directory Structure

```
.
├── AGENTS.md                        # Task coordination (read this first!)
├── TASKS.md                         # Current wave plan
├── CHANGELOG.md                     # Version history
├── README.md                        # Project overview
├── docs/                            # Documentation hub (architecture, guides, deep-dives)
├── devdocs/                         # Design notes, benchmarks, ADRs
├── config/                          # Config schema + examples
├── src/                             # TypeScript implementation (~105K lines)
│   ├── main.ts                      # MCP server entry point (stdio transport)
│   ├── server.ts                    # MCPServer class - tool dispatch + Zod validation
│   ├── domain/                      # Pure types + SymbolRepository port (hexagonal core)
│   ├── cli/                         # CLI commands + transports (stdio, http)
│   ├── config/                      # Config loading + Zod validation + constants
│   ├── db/                          # LadybugDB graph backend (schema + queries)
│   ├── indexer/                     # Symbol extraction + indexing pipeline
│   │   ├── adapter/                 # 11 language adapters (TS, Python, Go, etc.)
│   │   └── treesitter/              # AST extraction (symbols, imports, calls)
│   ├── graph/                       # Slice building, beam search, clustering
│   ├── delta/                       # Versioning, diff, blast radius
│   ├── code/                        # Code windows, skeleton IR, hot-path, gating
│   ├── code-mode/                   # Code Mode surfaces (`sdl.context`, `sdl.workflow`)
│   ├── memory/                      # File-backed memory sync (.sdl-memory/)
│   ├── mcp/                         # MCP types, tools, errors, telemetry
│   ├── gateway/                     # Tool gateway routing + compact schemas
│   ├── agent/                       # Autopilot orchestrator (plan, execute rungs)
│   ├── live-index/                  # Real-time draft buffer, overlay, reconcile
│   ├── policy/                      # Decision engine for context governance
│   ├── runtime/                     # Runtime execution engine
│   ├── services/                    # Application service layer
│   ├── startup/                     # Server initialization
│   ├── sync/                        # Export/import gzip artifacts (CI/CD)
│   ├── benchmark/                   # CI regression testing framework
│   ├── experiments/                 # Event log replay (offline testing)
│   ├── ts/                          # TypeScript compiler API diagnostics
│   ├── types/                       # Shared type definitions
│   ├── ui/                          # UI utilities
│   ├── util/                        # Helpers (paths, hashing, tokenizer, truncation)
│   ├── info/                        # Server diagnostics report builder (sdl.info)
│   ├── retrieval/                   # Task-shaped retrieval orchestrator + ranking
│   └── scip/                        # SCIP index decoder + ingestion + edge builder
├── native/                          # Rust addon via napi-rs (~52K lines)
├── tests/                           # Unit + integration + golden + property + stress tests
├── scripts/                         # Build, benchmark, migration scripts
├── templates/                       # MCP client config + agent instruction templates
├── migrations/                      # Legacy SQLite migrations (removed; directory kept for compat)
└── dist/                            # Compiled JavaScript (build output)
```

## Tech Stack

- **Runtime**: Node.js >=24.0.0
- **Language**: TypeScript 5.9.3 (strict mode, ESM)
- **MCP SDK**: @modelcontextprotocol/sdk ^1.29.0
- **Database**: LadybugDB (npm package alias `kuzu`, @ladybugdb/core 0.16.0) embedded graph database (single-file storage)
- **AST Parsing**: tree-sitter 0.26.2 (via @keqingmoe/tree-sitter) + language grammars consumed via `sdl-mcp-tree-sitter-*` wrapper packages (TS 0.23.2, Python 0.25.0, Go 0.25.0, Java 0.23.5, Rust 0.24.0, C# 0.23.1, C++ 0.23.4, C 0.24.1, Kotlin 0.3.8, PHP 0.24.2, Bash 0.25.1). Wrappers bundle each upstream grammar with a permissive `tree-sitter` peer range so consumer installs emit zero ERESOLVE warnings — see [grammar-wrappers/README.md](grammar-wrappers/README.md).
- **Native Indexer**: Rust via napi-rs with per-platform npm packages (`sdl-mcp-native`)
- **Embeddings**: ONNX Runtime + 3 models: all-MiniLM-L6-v2 (bundled), nomic-embed-text-v1.5, jina-embeddings-v2-base-code (optional, for semantic search)
- **Validation**: Zod ^4.3.6
- **Telemetry**: OpenTelemetry (tracing)
- **Optional**: chokidar (file watching), tokenizers (token counting)

## Architectural Pattern

Hexagonal/Ports-and-Adapters style:
- **Domain core**: `src/domain/` — pure types, `SymbolRepository` interface
- **Inbound adapters**: `src/indexer/` (files to symbols), `src/cli/` (CLI), `src/mcp/tools/` (MCP API)
- **Outbound adapters**: `src/db/` (LadybugDB), `src/indexer/adapter/` (language parsers)
- **Application services**: `src/graph/`, `src/delta/`, `src/code/`, `src/policy/`, `src/agent/`
- **Dependency flow**: `CLI/MCP -> tool handlers -> graph/delta/code/agent -> DB <- indexer`

## Database

SDL-MCP uses **LadybugDB** as the sole persistence layer (embedded graph DB stored as a single file on disk).

**Graph DB path resolution** (`src/db/initGraphDb.ts`):

1. `SDL_GRAPH_DB_PATH` (or legacy `SDL_DB_PATH`; `SDL_GRAPH_DB_DIR` is treated as a containing directory)
2. `graphDatabase.path` in config
3. Default: `<configDir>/sdl-mcp-graph.lbug`

Schema is created idempotently via `src/db/ladybug-schema.ts` on startup (no SQL migrations required).

**Graph schema**: 22 node tables, 14 edge tables. Key node types:
- **Core**: `Repo`, `File`, `Symbol`, `Version`, `SymbolVersion`, `Metrics`
- **Graph enrichment**: `Cluster`, `Process`, `FileSummary`
- **Infrastructure**: `SliceHandle`, `CardHash`, `Audit`, `AgentFeedback`, `SchemaVersion`
- **Semantic**: `SymbolEmbedding`, `SummaryCache`, `SymbolReference`
- **Sync/Policy**: `SyncArtifact`, `ToolPolicyHash`, `TsconfigHash`
- **Memory/Usage**: `Memory`, `UsageSnapshot`

**Key edge types**: `FILE_IN_REPO`, `SYMBOL_IN_FILE`, `SYMBOL_IN_REPO`, `DEPENDS_ON`, `VERSION_OF_REPO`, `BELONGS_TO_CLUSTER`, `PARTICIPATES_IN`, `HAS_MEMORY`, `MEMORY_OF`, `MEMORY_OF_FILE`, etc.

## MCP Tools

### Memory Tools (opt-in — requires `memory.enabled: true`)
| Tool | Purpose |
|------|---------|
| `sdl.memory.store` | Store / update a development memory |
| `sdl.memory.query` | Search memories by text, type, tags, symbols |
| `sdl.memory.remove` | Soft-delete a memory |
| `sdl.memory.surface` | Auto-surface relevant memories for a task |

Disabled memory tools do not appear in `sdl.action.search` or `sdl.workflow` output.

### Gateway Mode
When gateway mode is active the server may register only the metadata gateway surface (`sdl.action.search`, `sdl.context`, `sdl.workflow`, `sdl.manual`) and route everything else through it, reducing tool-registration overhead without duplicating generated inventory counts here.

### Observability Dashboard (HTTP transport only)
The HTTP transport exposes a built-in read-only dashboard at `/ui/observability` plus bearer-auth-gated REST + SSE routes under `/api/observability/{snapshot,timeseries,beam-explain,stream}`. Enabled by default via the `observability.*` config block (`enabled`, `sampleIntervalMs`, `retentionShortMinutes`, `retentionLongHours`, `beamExplainCapacity`, `beamExplainEntriesPerSlice`, `sseHeartbeatMs`, `pprMetricsEnabled`, `packedStatsEnabled`, `scipIngestMetrics`). Source lives at `src/observability/`; types in `src/observability/types.ts`. Full docs at `docs/feature-deep-dives/observability-dashboard.md`.

## CLI Commands

| Command | Description |
|---------|-------------|
| `sdl-mcp init` | Initialize config + database |
| `sdl-mcp doctor` | Health check and validation |
| `sdl-mcp info` | Server diagnostics and environment info |
| `sdl-mcp index` | Index repositories |
| `sdl-mcp serve` | Start MCP server (stdio or http) |
| `sdl-mcp version` | Show version info |
| `sdl-mcp benchmark:ci` | Run CI regression benchmarks |
| `sdl-mcp export` | Export sync artifacts (gzip) |
| `sdl-mcp import` | Import sync artifacts |
| `sdl-mcp pull` | Pull remote artifacts |
| `sdl-mcp health` | Health status check |
| `sdl-mcp summary` | Generate context summaries |
| `sdl-mcp tool <action>` | Direct MCP action invocation from CLI |

**Transports**: stdio (default for MCP clients), http (development)

Workflow notes:
- `sdl-mcp init --client <claude-code|codex|gemini|opencode> --enforce-agent-tools` writes SDL-first enforcement assets for the selected client.
- `sdl-mcp serve --stdio --dashboard-port <port>` keeps MCP traffic on stdio and exposes only the loopback observability dashboard, observability API, and `/health`.
- `sdl-mcp index` delegates to a running HTTP server when possible so it does not open the graph database directly while the server owns the lock.
- Provider-first SCIP indexing is controlled by `indexing.pipeline` (`auto`, `providerFirst`, `legacy`). `auto` uses provider-first when trustworthy SCIP facts are available and otherwise falls back; explicit `providerFirst` still uses same-run legacy fallback for uncovered or provider-unusable files, but unsafe provider facts fail loudly.
- For provider-first `sdl-mcp index` runs, treat `Provider-first timings`, legacy fallback diagnostics, provider-unusable/call-proof diagnostics, `Semantic readiness: deferred`, and `Provider-first shadow DB ...` lines as primary debugging signals. Shadow staging/finalization artifacts are written beside the active graph DB under `provider-first-shadow/<repoId>/<generationId>/`; requested Parquet staging currently records a CSV fallback in the manifest.
- `sdl-mcp tool --list` shows the current direct-action matrix. The CLI proxies only `action.search`/`sdl.action.search` and `manual`/`sdl.manual` from the meta tools; `sdl.context`, `sdl.workflow`, and `sdl.file` remain MCP-only wrapper tools. For CLI writes, use `file.write`, `search.edit`, or `symbol.edit --mode applyNow`; `symbol.edit --mode apply` requires the MCP/server session that created the preview plan.

## Development Commands

```bash
npm install                   # Install dependencies
npm run build                 # Compile runtime TS and copy UI assets
npm run build:all             # Full build (clean + tsc + scripts)
npm run typecheck             # Type check only (no emit)
npm run typecheck:scripts     # Type check scripts tsconfig only
npm run lint                  # ESLint (import/extensions enforced)
npm test                      # Build, init LadybugDB, run all tests (serial, node:test)
npm run test:integration      # Integration tests
npm run test:parity           # Engine parity integration test
npm run test:native-parity    # Native addon parity test
npm run test:harness          # Adapter integration tests
npm run test:golden           # Validate golden MCP response snapshots
npm run golden:update         # Regenerate golden snapshots
npm run test:stress           # Stress tests (concurrent clients)
npm run test:mutation         # Mutation testing (Stryker)
npm run test:coverage         # Node test coverage run
npm run docs:tools:check      # Verify generated tool inventory is current
npm run docs:tools:generate   # Regenerate tool inventory docs
npm run check:config-sync     # Verify config examples/schema stay in sync
npm run check:schema-sync     # Verify schema-generated surfaces stay in sync
npm run dev                   # Run src/main.ts directly
npm run build:native          # Compile Rust addon (requires Rust toolchain)
npm run benchmark:ci          # Run CLI CI benchmark checks (requires built dist)
npm run benchmark             # Run benchmark suite
```

## Key Concepts

### SymbolID
Stable hash of: `repoId + relPath + kind + name + astFingerprint`. Survives whitespace/trivial refactors.

### Symbol Card
Compact JSON containing: identity, signature, 1-2 line summary, invariants, side effects, dependency edges (imports/calls), metrics (fan-in/out, churn, test refs).

### Graph Slice
Computed context subset via BFS/beam search. Weighted edges: call (1.0) > config (0.8) > import (0.6). Stops at token budget or score threshold. Returns cards before any raw code.

### Delta Pack
Changes between ledger versions. Includes changed symbols with signature/invariant/side-effect diffs plus ranked blast radius (dependent symbols by proximity + fan-in + test proximity).

### Context Ladder (4 Rungs)
1. **Symbol Cards** - Always available, minimal tokens
2. **Skeleton IR** - Deterministic code outline
3. **Hot-Path Excerpt** - Critical code paths only
4. **Full Window** - Complete code (gated, requires justification)

### SCIP Integration
Optional compiler-grade cross-references via SCIP (Source Code Intelligence Protocol). Ingest `.scip` index files from scip-typescript, scip-go, rust-analyzer, etc. to upgrade heuristic edges to exact edges (`resolution: "exact"`, confidence 0.95), add external dependency symbols as graph nodes, and create `implements` edges for interface/trait relationships. Auto-ingests on `sdl.index.refresh` when configured.

Provider-first full SCIP runs materialize provider-primary files, coalesce duplicate raw SCIP documents/facts by normalized repo-relative path, route uncovered or provider-unusable files through same-run legacy fallback, and defer semantic embedding/summary refresh as separate readiness work. Call edges are promoted only when source text proves the expected symbol/invocation; incomplete proof remains occurrence data and is surfaced in CLI diagnostics. The default Louvain policy is `indexing.algorithmRefresh.louvain.maxCallEdges: 10000`; raise it only when shadow community detection is worth the extra full-index time.

### Proof-of-Need Gating
`code.needWindow` requests require: `symbolId`, reason, expected lines, identifiers to find. `code.getHotPath` also requires `symbolId` + `identifiersToFind`. Get `symbolId` from `symbol.search` or `symbol.getCard` first. Approval if identifiers exist in range, symbol in slice/frontier, scorer utility > threshold, or break-glass with audit. Denials include actionable guidance.

## Coding Standards

### ESM Import Requirements
All TypeScript imports must include `.js` extension:
```typescript
// Correct
import { foo } from "./utils.js";

// Incorrect (will fail at runtime)
import { foo } from "./utils";
```

### Naming Conventions
- Files: kebab-case (`file-scanner.ts`)
- Types/Interfaces: PascalCase (`SymbolCard`)
- Functions: camelCase (`buildGraphSlice`)
- Constants: SCREAMING_SNAKE_CASE (`MAX_WINDOW_LINES`)

### Import Order
1. Node.js built-ins
2. External packages
3. Internal absolute imports
4. Relative imports

### Database Conventions (LadybugDB/Cypher)
- All queries via `src/db/ladybug-queries.ts` barrel (or specific `ladybug-*.ts` module)
- Always `normalizePath()` before storing paths — forward-slash only in DB
- Use `MERGE` (never `INSERT`/`CREATE`) for idempotent upserts
- Wrap numeric results with `toNumber()` (LadybugDB returns bigint)
- Use `withTransaction()` for multi-statement writes
- Never interpolate values into Cypher — use `$paramName`

### Windows Considerations
- All path handling must use `src/util/paths.ts` helpers
- Store relative paths in DB, resolve to absolute on read
- Handle backslash/forward-slash conversion (`normalizePath()`)
- Graph DB path is a Ladybug database file; legacy directory-style paths are normalized to `<dir>/sdl-mcp-graph.lbug`

## Key Type Files

- `src/domain/types.ts` - Canonical domain types (SymbolCard, GraphSlice, DeltaPack)
- `src/domain/errors.ts` - Typed errors (ConfigError, DatabaseError, IndexError, etc.)
- `src/db/ladybug-queries.ts` - Graph queries barrel (imports domain-specific modules)
- `src/db/ladybug-schema.ts` - Idempotent Cypher schema DDL (version 3)
- `src/db/initGraphDb.ts` - Graph DB path resolution + init
- `src/policy/types.ts` - Policy engine types
- `src/config/types.ts` - Configuration schemas

## Documentation

| File | Purpose |
|------|---------|
| `AGENTS.md` | Development coordination + knowledge base |
| `TASKS.md` | Current wave plan |
| `CHANGELOG.md` | Version history |
| `README.md` | Project overview |
| `docs/` | User guide, architecture, CLI reference, tool deep-dives |
| `docs/feature-deep-dives/` | Detailed feature documentation |
| `devdocs/` | Design notes, ADRs, benchmarks, plans |
| `tests/` | Unit + integration + golden + property + stress tests |

## Anti-Patterns (Do NOT)

- **No `as any` / `@ts-ignore`** in `src/` (strict mode enforced)
- **No raw file reads in MCP tool handlers** — use DB queries
- **No `CREATE` for upserts** — always `MERGE` in Cypher
- **No direct `conn.query()`** — use `exec`/`queryAll`/`querySingle` from `ladybug-core.ts`
- **No bundler** — build is plain `tsc`; do not add esbuild/rollup for main build
- **No vitest/jest** — tests use Node.js built-in test runner (`node:test` + `--experimental-strip-types`)
- **No `npm install` in CI** — use `npm ci --ignore-scripts --legacy-peer-deps` then `npm rebuild tree-sitter*`

## Environment Variables

- `SDL_CONFIG` - Config file path
- `SDL_GRAPH_DB_PATH` / `SDL_GRAPH_DB_DIR` - Graph DB file override (`SDL_GRAPH_DB_DIR` points to the containing directory)
- `SDL_DB_PATH` - Legacy alias for graph DB path (v0.7.x)
- `SDL_LOG_LEVEL` - Log level (debug, info, warn, error)
- `SDL_LOG_FORMAT` - Log format (json, text)
- `SDL_MCP_DISABLE_NATIVE_ADDON` - Set `1` to force TS fallback (tests do this)
