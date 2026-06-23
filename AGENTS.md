# AGENTS.md - SDL-MCP Knowledge Base

Use SDL-MCP as the default path for repository `sdl-mcp`.

SDL-MCP (Symbol Delta Ledger MCP Server) - an MCP server providing cards-first code context for polyglot repositories. Replaces bulk code reads with structured symbol cards, graph slices, delta packs, and gated code windows. Uses LadybugDB (graph DB), tree-sitter (AST parsing), and optional Rust native addon (napi-rs) for performance.

> Optimized tool-use workflow for agents: see [SDL.md](./SDL.md).

## STRUCTURE

```
.
src/
  main.ts                 # MCP server entry (stdio transport)
  server.ts               # MCPServer class - tool dispatch + Zod validation
  domain/                 # Pure types + SymbolRepository port (hexagonal core)
  indexer/                # File scan, parse, symbol extract, DB write [AGENTS.md]
  db/                     # LadybugDB persistence (12 domain modules) [AGENTS.md]
  graph/                  # Slice building, beam search, clustering [AGENTS.md]
  mcp/                    # MCP tool handlers + Zod schemas [AGENTS.md]
  live-index/             # Real-time draft buffer, overlay, reconcile [AGENTS.md]
  code/                   # Skeleton IR, hot-path, gated windows [AGENTS.md]
  cli/                    # CLI binary + commands + transports [AGENTS.md]
  delta/                  # Version diffing + blast radius BFS
  agent/                  # Autopilot orchestrator (plan, execute rungs)
  policy/                 # Rule-based context governance engine
  config/                 # Config loading, Zod validation, constants
  sync/                   # Export/import gzip artifacts (CI/CD)
  util/                   # Paths, logger, hashing, tokenizer, truncation
  benchmark/              # CI regression testing framework
  ts/                     # TypeScript compiler API diagnostics
  experiments/            # Event log replay (offline testing)
native/                   # Rust addon via napi-rs [AGENTS.md]
tests/                    # Unit + integration + golden + property tests [AGENTS.md]
scripts/                  # Build, benchmark, migration scripts
config/                   # JSON Schema + example configs
devdocs/                  # PRDs, benchmarks, design docs
dist/                     # Compiled output (mirrors src/)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/modify MCP tool | `src/mcp/tools/` handler + `src/mcp/tools.ts` schema | Follow Zod schema then handler pattern |
| Add language support | `src/indexer/adapter/` + `src/indexer/treesitter/` | Implement `LanguageAdapter` interface |
| Fix DB query | `src/db/ladybug-*.ts` (domain-specific) | Import via `ladybug-queries.ts` barrel |
| Modify slice algorithm | `src/graph/slice/beam-search-engine.ts` | Beam search with 5-factor scoring |
| Add CLI command | `src/cli/commands/` | Register in `src/cli/index.ts` |
| Fix path handling | `src/util/paths.ts` | Windows normalization, forward-slash in DB |
| Modify policy rules | `src/policy/engine.ts` | Priority-ordered rule chain |
| Domain types | `src/domain/types.ts` | Canonical type definitions |
| Domain errors | `src/domain/errors.ts` | ConfigError, DatabaseError, IndexError, etc. |

## ARCHITECTURE

Hexagonal (Ports & Adapters):
- **Domain core**: `src/domain/` - pure types, `SymbolRepository` interface
- **Inbound adapters**: `src/indexer/` (files to symbols), `src/cli/` (CLI), `src/mcp/tools/` (MCP API)
- **Outbound adapters**: `src/db/` (LadybugDB), `src/indexer/adapter/` (language parsers)
- **Application services**: `src/graph/`, `src/delta/`, `src/code/`, `src/policy/`, `src/agent/`

Dependency flow: `CLI/MCP -> tool handlers -> graph/delta/code/agent -> DB <- indexer`

## CONVENTIONS

### ESM - All imports MUST use `.js` extension (ESLint enforced as error)

```typescript
import { foo } from "./utils.js";       // correct
import { foo } from "./utils";          // BREAKS at runtime
```

### Import order: Node builtins, external packages, internal absolute, relative

### Naming
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`

### DB access
- All queries via `src/db/ladybug-queries.ts` barrel (or specific `ladybug-*.ts` module)
- Always `normalizePath()` before storing paths - forward-slash only in DB
- Use `MERGE` (never `INSERT`) for idempotent upserts
- Wrap numeric results with `toNumber()` (LadybugDB returns bigint)
- Use `withTransaction()` for multi-statement writes
- Never interpolate values into Cypher - use `$paramName`

### Error handling
- Use typed errors from `src/domain/errors.ts`
- Never swallow errors - log with context via `src/util/logger.ts`
- Unused vars: prefix with `_` (e.g., `_unused`)

### Path handling (Windows-first dev)
- Always use `src/util/paths.ts` helpers
- Store relative paths in DB, resolve to absolute on read
- `normalizePath()` converts backslash to forward-slash

## ANTI-PATTERNS (THIS PROJECT)

- **No `as any` / `@ts-ignore`** in `src/` (strict mode enforced)
- **No raw file reads in MCP tool handlers** - use DB queries
- **No `CREATE` for upserts** - always `MERGE` in Cypher
- **No direct `conn.query()`** - use `exec`/`queryAll`/`querySingle` from `ladybug-core.ts`
- **No bundler** - build is plain `tsc`, do not add esbuild/rollup for main build
- **No vitest/jest** - tests use Node.js built-in test runner (`node:test` + `--experimental-strip-types`)
- **No `npm install` in CI** - use `npm ci --ignore-scripts --legacy-peer-deps` then `npm rebuild tree-sitter*`

## COMMANDS

```bash
npm run build:all             # Full build (clean + tsc + scripts)
npm run typecheck             # Type check only (no emit)
npm run lint                  # ESLint (import/extensions enforced)
npm test                      # Build, init LadybugDB, run all tests (serial, node:test)
npm run dev                   # Run via --experimental-strip-types (no build needed)
npm run build:native          # Compile Rust addon (requires Rust toolchain)
npm run test:golden           # Validate golden MCP response snapshots
npm run golden:update         # Regenerate golden snapshots
```

## ENVIRONMENT

| Variable | Purpose |
|----------|---------|
| `SDL_GRAPH_DB_PATH` | LadybugDB file path override |
| `SDL_GRAPH_DB_DIR` | LadybugDB containing directory |
| `SDL_CONFIG` | Config file path |
| `SDL_LOG_LEVEL` | debug/info/warn/error |
| `SDL_MCP_DISABLE_NATIVE_ADDON` | Set `1` to force TS fallback (tests do this) |

## KEY TYPES

| Type | File | Purpose |
|------|------|---------|
| `SymbolCard` | `src/domain/types.ts` | Compact symbol metadata (identity, signature, summary, deps) |
| `GraphSlice` | `src/domain/types.ts` | Task-scoped dependency subgraph |
| `DeltaPack` | `src/domain/types.ts` | Version diff with blast radius |
| `PolicyDecision` | `src/policy/types.ts` | Gating decision for code access |
| `RepoConfig` | `src/config/types.ts` | Per-repo configuration |

## MCP TOOLS (20+)

| Tool | Handler | Domain |
|------|---------|--------|
| `sdl.repo.register/status` | `src/mcp/tools/repo.ts` | Repository management |
| `sdl.repo.overview` | `src/mcp/tools/repo.ts` | Token-efficient codebase overview |
| `sdl.index.refresh` | `src/mcp/tools/repo.ts` | Trigger indexing |
| `sdl.symbol.search/getCard/getCards` | `src/mcp/tools/symbol.ts` | Symbol lookup |
| `sdl.slice.build/refresh/spillover.get` | `src/mcp/tools/slice.ts` | Graph slicing |
| `sdl.delta.get` | `src/mcp/tools/delta.ts` | Version diffing |
| `sdl.code.needWindow/getSkeleton/getHotPath` | `src/mcp/tools/code.ts` | Code access (gated) |
| `sdl.policy.get/set` | `src/mcp/tools/policy.ts` | Policy management |
| `sdl.context` | `src/mcp/tools/context.ts` | Task-shaped context retrieval |
| `sdl.agent.feedback/feedback.query` | `src/mcp/tools/agent-feedback.ts` | Feedback loop |
| `sdl.buffer.push/checkpoint/status` | `src/mcp/tools/buffer.ts` | Live draft indexing |
|  | `src/mcp/tools/summary.ts` | Context summaries |
| `sdl.pr.risk.analyze` | `src/mcp/tools/prRisk.ts` | PR risk analysis |
| `sdl.file.read` | `src/mcp/tools/file-read.ts` | Non-indexed file reader |
| `sdl.file.write` | `src/mcp/tools/file-write.ts` (+ `file-write-internals.ts`) | Single-file write (indexed or non-indexed); helpers shared with `search.edit` |
| `sdl.search.edit` | `src/mcp/tools/search-edit/` | Cross-file search/edit (preview + apply, sha256 preconditions, rollback) |

### Next steps

- `sdl.search.edit` v1 ships in 0.10.8 Unreleased with text + symbol
  targeting and the common edit modes. `jsonPath` and hybrid-retrieval
  narrowing for text mode are deferred; expand the test matrix
  (unit/property/golden/stress) before broadening scope.

## NOTES

- **Dual entry points**: `src/main.ts` (direct MCP) and `src/cli/commands/serve.ts` (via CLI) both instantiate `MCPServer`
- **Rust addon is optional**: All Rust paths have TS fallbacks. Tests run without native addon.
- **LadybugDB schema is idempotent**: No migrations - uses `IF NOT EXISTS`. Breaking changes require DB rebuild.
- **Schema split**: `createBaseSchema()` creates tables + schema version; `createSecondaryIndexes()` creates 19 scalar indexes. Fresh DB init defers secondary indexes until after first full index.
- **Schema version**: `LADYBUG_SCHEMA_VERSION = 3` in `ladybug-schema.ts`. Mismatch causes error.
- **Write pool**: 4 warm connections with two-layer concurrency (`writeLimiter` for connection acquisition, `writeExecMutex` for serialized DB execution). LadybugDB allows only one write transaction at a time.
- **Batch persistence**: Both Rust and TS pass1 paths use `BatchPersistAccumulator` with background drain loop. Auto-enqueues at 200-row threshold. `.error` property enables early break on write failure.
- **`slice.ts` + `slice/` coexist**: `slice.ts` is orchestration; `slice/` has beam search sub-modules.
- **11 language adapters**: TS, Python, Go, Java, Rust, C#, C++, C, Kotlin, PHP, Shell + plugin system.
- **CI matrix**: ubuntu-latest + windows-latest, Node 24.x.

### ALWAYS USE SDL-MCP TOOLS TO READ CODE FILES IN REPOS



### 11) Development memories

Store cross-session knowledge that auto-surfaces in future slice builds:

- **Store**: `sdl.memory.store` with `type` (`"decision"` | `"bugfix"` | `"task_context"` | `"pattern"` | `"convention"` | `"architecture"` | `"performance"` | `"security"`), `title`, `content`, optional `symbolIds`, `fileRelPaths`, `tags`, `confidence`.
- **Query**: `sdl.memory.query` with `query` (text search), `types`, `tags`, `symbolIds`, `staleOnly`, `limit`, `sortBy` (`"recency"` | `"confidence"`).
- **Surface**: `sdl.memory.surface` with `symbolIds` and/or `taskType` — returns ranked by confidence × recency × symbol overlap.
- **Remove**: `sdl.memory.remove` with `memoryId`; add `deleteFile: true` to also remove the `.sdl-memory/` file.
- **Automatic surfacing**: `sdl.slice.build` includes relevant memories by default. Set `includeMemories: false` to disable, or `memoryLimit: N` to control count.
- **Staleness**: after refactors, query `sdl.memory.query` with `staleOnly: true` and update or remove outdated memories.
- **Team sharing**: memories save to `.sdl-memory/` files; commit to Git. On `sdl.index.refresh`, other team members' files are imported into the graph.

```
