# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SDL-MCP** (Symbol Delta Ledger MCP Server) is a Model Context Protocol server for TypeScript/JavaScript repositories with Windows-first development. It replaces bulk code context with:

- **Symbol Cards**: Stable, compact metadata for functions/classes/interfaces
- **Graph Slices**: Task-scoped dependency subgraphs (cards-first, not raw code)
- **Delta Packs**: Change tracking between ledger versions with blast radius computation
- **Proof-of-Need Code Windows**: Gated raw code retrieval requiring justification

## Current State

**Version**: 0.5.1 (v0.5.1 Release Hardening phase)

The implementation is **fully complete** in the `sdl-mcp/` subdirectory with:
- 60+ TypeScript source files (~13,000 lines)
- 13 MCP tools implemented
- 5 CLI commands
- 6 database migrations
- Full test infrastructure
- GitHub Actions CI/CD

**Remaining Tasks** (see `sdl-mcp/AGENTS.md`):
- `34-2.2`: Make `npm test` pass E2E
- `34-2.3`: Add test:harness to CI
- `33-1.1`: LICENSE file (exists but marked TODO in registry)

## Directory Structure

```
F:\Claude\projects\sdl-mcp\
├── CLAUDE.md                        # This file (project guidance)
├── Symbol_Data_Ledger_MCP.md        # Original PRD
└── sdl-mcp/                         # Implementation directory
    ├── package.json                 # v0.5.1, ESM module
    ├── AGENTS.md                    # Task coordination (read this first!)
    ├── COMPLETED.md                 # 108+ archived tasks
    ├── CHANGELOG.md                 # Version history
    ├── README.md                    # CLI documentation
    ├── TESTING.md                   # Dist-first test strategy
    ├── src/                         # TypeScript source
    │   ├── main.ts                  # MCP server entry point
    │   ├── server.ts                # MCP wiring + tool dispatch
    │   ├── cli/                     # CLI commands + transports
    │   ├── config/                  # Config loading + Zod validation
    │   ├── db/                      # SQLite schema, queries, migrations
    │   ├── indexer/                 # Symbol extraction (tree-sitter + TS)
    │   ├── graph/                   # Slice building, scoring, budgeting
    │   ├── delta/                   # Versioning, diff, blast radius
    │   ├── code/                    # Code windows, skeleton, gating
    │   ├── mcp/                     # MCP types, tools, errors, telemetry
    │   ├── policy/                  # Decision engine for context governance
    │   ├── ts/                      # TypeScript diagnostics integration
    │   └── util/                    # Helpers (paths, hashing, truncation)
    ├── dist/                        # Compiled JavaScript (build output)
    ├── migrations/                  # SQL migration files (0001-0006)
    ├── config/                      # Config schema + examples
    ├── templates/                   # MCP client config templates
    ├── tests/                       # Unit + integration tests
    └── scripts/                     # Build/migration/index scripts
```

## Tech Stack

- **Runtime**: Node.js >=18.0.0
- **Language**: TypeScript 5.9.3 (strict mode, ESM)
- **MCP SDK**: @modelcontextprotocol/sdk ^0.4.0
- **Database**: SQLite via better-sqlite3 ^11.0.0 (synchronous, Windows-friendly)
- **AST Parsing**: tree-sitter + tree-sitter-typescript ^0.21.0
- **Validation**: Zod ^3.23.0
- **Optional**: chokidar (file watching)

## Architectural Pattern

Hexagonal/Ports-and-Adapters style:
- `indexer/*` produces pure domain objects (symbols/edges), no DB writes
- `db/queries.ts` owns persistence
- `graph/*` only reads from DB (no mutation)
- `delta/*` reads versions, computes diffs on demand
- `code/*` reads file content + applies gating policy

## Database

SQLite with WAL mode. 6 migrations in `/migrations`:
1. `0001_init.sql` - Core tables (repos, files, symbols, edges)
2. `0002_edges_indexes.sql` - Optimization indexes
3. `0003_versions.sql` - Versioning tables
4. `0004_metrics_audit.sql` - Metrics and audit logging
5. `0005_slice_handles.sql` - Slice handle/lease protocol
6. `0006_content_addressed.sql` - Merkle chain for ledger integrity

## MCP Tools (13 Implemented)

| Tool | Purpose |
|------|---------|
| `sdl.repo.register` | Register repository |
| `sdl.repo.status` | Get repository status |
| `sdl.index.refresh` | Trigger re-indexing (full/incremental) |
| `sdl.symbol.search` | Search symbols by pattern |
| `sdl.symbol.getCard` | Get symbol card with ETag |
| `sdl.slice.build` | Build graph slice with handle/lease |
| `sdl.slice.refresh` | Delta-only refresh |
| `sdl.slice.spillover.get` | Paged overflow fetch |
| `sdl.delta.get` | Get delta pack between versions |
| `sdl.code.needWindow` | Request code window (gated) |
| `sdl.code.getSkeleton` | Get deterministic skeleton IR |
| `sdl.code.getHotPath` | Get hot-path excerpt |
| `sdl.policy.get`/`set` | Policy management |

## CLI Commands

| Command | Description |
|---------|-------------|
| `sdl-mcp init` | Initialize config + database |
| `sdl-mcp doctor` | Health check and validation |
| `sdl-mcp index` | Index repositories |
| `sdl-mcp serve` | Start MCP server |
| `sdl-mcp version` | Show version info |

**Transports**: stdio (default for MCP clients), http (development)

## Development Commands

```bash
cd sdl-mcp                    # Enter implementation directory
npm install                   # Install dependencies
npm run build:all             # Build everything (required before testing)
npm run typecheck             # Type check only
npm run lint                  # ESLint
npm run test                  # Unit tests
npm run test:harness          # Integration tests
npm run dev                   # Run via tsx (development)
```

## Windows Environment Setup

Node.js is installed via NVM (Node Version Manager) on this system. To run npm commands in bash:

```bash
# Set PATH for nvm-managed Node.js
export PATH="/c/Users/glitt/AppData/Local/nvm/v22.21.1:/c/Users/glitt/AppData/Roaming/npm:$PATH"

# Then run npm commands
npm run build:all
npm test
```

**Node locations:**
- NVM directory: `/c/Users/glitt/AppData/Local/nvm/`
- Available versions: `v22.21.1`, `v24.12.0`
- Global npm packages: `/c/Users/glitt/AppData/Roaming/npm/`

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

### Proof-of-Need Gating
`code.needWindow` requests require: reason, expected lines, identifiers to find. Approval if identifiers exist in range, symbol in slice/frontier, scorer utility > threshold, or break-glass with audit. Denials include actionable guidance.

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

### Windows Considerations
- All path handling must use `src/util/paths.ts` helpers
- Store relative paths in DB, resolve to absolute on read
- Handle backslash/forward-slash conversion
- Use `better-sqlite3` (synchronous, not async drivers)

## Key Type Files

- `src/db/schema.ts` - Database row types
- `src/mcp/types.ts` - Domain types (SymbolCard, GraphSlice, DeltaPack)
- `src/policy/types.ts` - Policy engine types
- `src/config/types.ts` - Configuration schemas

## Documentation

| File | Purpose |
|------|---------|
| `Symbol_Data_Ledger_MCP.md` | Original PRD (base) |
| `sdl-mcp/SDL-MCP_v0.4.md` | v0.4 features (skeletonization, diagnostics, CLI) |
| `sdl-mcp/SDL-MCP_v0.5.md` | v0.5 features (sync, policy, ledger, governor) |
| `sdl-mcp/AGENTS.md` | Current task coordination |
| `sdl-mcp/COMPLETED.md` | Archived task history |
| `sdl-mcp/README.md` | CLI documentation |
| `sdl-mcp/TESTING.md` | Test execution strategy |

## Environment Variables

- `SDL_CONFIG` - Config file path
- `SDL_LOG_LEVEL` - Log level (debug, info, warn, error)
- `SDL_LOG_FORMAT` - Log format (json, text)
- `SDL_DB_PATH` - Database path override

# CLAUDE.md - SDL-MCP Integration

This file instructs Claude Code (and other AI agents) to use SDL-MCP for efficient code context.

## Code Context Protocol

**IMPORTANT**: This project uses SDL-MCP for code understanding. Always prefer SDL-MCP tools over reading raw files directly.

### Repository Configuration

- **Repository ID**: `{{REPO_ID}}`
- **MCP Server**: sdl-mcp

### Context Ladder (Use in Order)

When you need to understand code, follow this escalation path:

| Step | Tool | Token Cost | When to Use |
|------|------|------------|-------------|
| 1 | `sdl.symbol.search` | ~50 | Find symbols by name |
| 2 | `sdl.symbol.getCard` | ~135 | Understand signatures, deps, summary |
| 3 | `sdl.slice.build` | ~800 | Get related symbols for a task |
| 4 | `sdl.code.getSkeleton` | ~113 | See control flow structure |
| 5 | `sdl.code.getHotPath` | ~200 | Find specific identifiers |
| 6 | `sdl.code.needWindow` | Variable | Full code (last resort) |

### Tool Usage Guidelines

#### Finding Code

```
# Search for symbols by name
sdl.symbol.search({ repoId: "{{REPO_ID}}", query: "functionName" })

# Search with filters
sdl.symbol.search({
  repoId: "{{REPO_ID}}",
  query: "parse",
  kinds: ["function", "method"],
  limit: 20
})
```

#### Understanding Code

```
# Get symbol metadata (signature, summary, dependencies)
sdl.symbol.getCard({ repoId: "{{REPO_ID}}", symbolId: "<id>" })

# Get related symbols for context
sdl.slice.build({
  repoId: "{{REPO_ID}}",
  entrySymbols: ["<symbolId>"],
  maxCards: 30
})
```

#### Reading Code (When Necessary)

```
# Get code skeleton (signatures + control flow, elided bodies)
sdl.code.getSkeleton({ repoId: "{{REPO_ID}}", symbolId: "<id>" })

# Find specific identifiers in code
sdl.code.getHotPath({
  repoId: "{{REPO_ID}}",
  symbolId: "<id>",
  identifiers: ["errorHandler", "validate"]
})

# Get raw code (requires justification)
sdl.code.needWindow({
  repoId: "{{REPO_ID}}",
  symbolId: "<id>",
  reason: "Need to understand validation implementation details",
  expectedIdentifiers: ["validateInput"]
})
```

### Required Practices

1. **Always search first**: Use `sdl.symbol.search` before trying to read files
2. **Get cards before code**: Use `sdl.symbol.getCard` to understand what a symbol does
3. **Use slices for context**: Use `sdl.slice.build` to find related code
4. **Justify raw code requests**: Always provide a `reason` for `sdl.code.needWindow`
5. **Follow nextBestAction**: If a request is denied, use the suggested alternative

### Do NOT

- Read entire files with the `Read` tool when SDL-MCP can provide the context
- Skip cards and go directly to raw code
- Ignore policy denials - use the `nextBestAction` suggestion
- Request raw code without trying cards/skeletons first

### Workflow Examples

#### Bug Investigation

1. Search for the problematic function:
   ```
   sdl.symbol.search({ repoId: "{{REPO_ID}}", query: "handleError" })
   ```

2. Get the card to understand its purpose and dependencies:
   ```
   sdl.symbol.getCard({ repoId: "{{REPO_ID}}", symbolId: "<found-id>" })
   ```

3. Build a slice to see related error handling:
   ```
   sdl.slice.build({ repoId: "{{REPO_ID}}", entrySymbols: ["<id>"], maxCards: 20 })
   ```

4. If needed, get the skeleton to see control flow:
   ```
   sdl.code.getSkeleton({ repoId: "{{REPO_ID}}", symbolId: "<id>" })
   ```

5. Only if the bug requires seeing exact implementation:
   ```
   sdl.code.needWindow({
     repoId: "{{REPO_ID}}",
     symbolId: "<id>",
     reason: "Need to see exact error condition logic",
     expectedIdentifiers: ["errorCode", "throwError"]
   })
   ```

#### Feature Implementation

1. Search for similar existing features:
   ```
   sdl.symbol.search({ repoId: "{{REPO_ID}}", query: "create", kinds: ["function"] })
   ```

2. Get cards for relevant symbols to understand patterns:
   ```
   sdl.symbol.getCard({ repoId: "{{REPO_ID}}", symbolId: "<id>" })
   ```

3. Build a slice from the entry point:
   ```
   sdl.slice.build({ repoId: "{{REPO_ID}}", entrySymbols: ["<entry-id>"], maxCards: 50 })
   ```

4. Use skeletons to understand structure without full code:
   ```
   sdl.code.getSkeleton({ repoId: "{{REPO_ID}}", symbolId: "<id>" })
   ```

#### Code Review

1. Get the delta pack to see what changed:
   ```
   sdl.delta.get({ repoId: "{{REPO_ID}}" })
   ```

2. For each changed symbol, get its card:
   ```
   sdl.symbol.getCard({ repoId: "{{REPO_ID}}", symbolId: "<changed-id>" })
   ```

3. Check blast radius for impact:
   ```
   sdl.delta.get({ repoId: "{{REPO_ID}}", includeBlastRadius: true })
   ```

### Refreshing the Index

If you've made changes and need to update the symbol database:

```
sdl.index.refresh({ repoId: "{{REPO_ID}}", mode: "incremental" })
```

### Getting Help

- Check repository status: `sdl.repo.status({ repoId: "{{REPO_ID}}" })`
- View current policy: `sdl.policy.get({ repoId: "{{REPO_ID}}" })`
