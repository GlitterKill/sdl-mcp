# AGENTS.md - SDL-MCP Development Coordination

## Quick Reference

- **Last Modified**: 2026-02-08
- **Current Phase**: v0.6 Planning and Execution
- **Active Tasks**: 11 (V06-1 through V06-11)
- **Completed Tasks**: See [COMPLETED.md](./COMPLETED.md)

## Project Context

- **Project**: SDL-MCP (Symbol Delta Ledger MCP Server)
- **PRD Documents**: `devdocs/Symbol_Data_Ledger_MCP.md` (base), `devdocs/SDL-MCP_v0.4.md`, `devdocs/SDL-MCP_v0.5.md`, `devdocs/SDL-MCP_v0.6.md`, `devdocs/SDL-MCP_Hosted_Cloud_Explore_PRD.md`
- **Tech Stack**: Node.js, TypeScript, SQLite (better-sqlite3), tree-sitter, Zod
- **Version**: 0.5.1

---

## Agent Instructions

### Before Starting a Task

1. Check this file for task status and dependencies
2. Verify all dependencies are marked DONE
3. Update task status to IN_PROGRESS with your agent ID
4. Read relevant PRD sections and CLAUDE.md

### While Working

- Follow hexagonal architecture (indexer produces domain objects, db owns persistence)
- Use types from `src/db/schema.ts` and `src/mcp/types.ts`
- Windows path handling required (use `src/util/paths.ts`)
- No hardcoded paths, use config
- All imports must have `.js` extension (ESM requirement)
- Always use the `sdl-mcp` MCP server for code context before reading raw files

### After Completing

1. Update task status to DONE
2. Note any blockers or follow-up items
3. Update "Last Modified" timestamp

# CLAUDE.md - SDL-MCP Integration

This file instructs Claude Code (and other AI agents) to use SDL-MCP for efficient code context.

## Code Context Protocol

**IMPORTANT**: This project uses SDL-MCP for code understanding. Always prefer SDL-MCP tools over reading raw files directly.

### Repository Configuration

- **Repository ID**: `{{REPO_ID}}`
- **MCP Server**: sdl-mcp

### Context Ladder (Use in Order)

When you need to understand code, follow this escalation path:

| Step | Tool                   | Token Cost | When to Use                          |
| ---- | ---------------------- | ---------- | ------------------------------------ |
| 1    | `sdl.symbol.search`    | ~50        | Find symbols by name                 |
| 2    | `sdl.symbol.getCard`   | ~135       | Understand signatures, deps, summary |
| 3    | `sdl.slice.build`      | ~800       | Get related symbols for a task       |
| 4    | `sdl.code.getSkeleton` | ~113       | See control flow structure           |
| 5    | `sdl.code.getHotPath`  | ~200       | Find specific identifiers            |
| 6    | `sdl.code.needWindow`  | Variable   | Full code (last resort)              |

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

---

## v0.5.1 Task Registry

### Group 33: Release Blockers (CRITICAL)

These tasks MUST be completed before npm publish.

| ID     | Task                | Status | Agent  | Dependencies | Notes                   |
| ------ | ------------------- | ------ | ------ | ------------ | ----------------------- |
| 33-1.1 | Create LICENSE file | DONE   | Claude | None         | MIT license file exists |

### Group 34: Test Infrastructure

| ID     | Task                             | Status | Agent    | Dependencies | Notes                                        |
| ------ | -------------------------------- | ------ | -------- | ------------ | -------------------------------------------- |
| 34-2.1 | Document test execution strategy | DONE   | OpenCode | None         | Documented dist-first strategy in TESTING.md |
| 34-2.2 | Make `npm test` pass E2E         | DONE   | Claude   | 34-2.1       | Tests pass after debug log cleanup           |
| 34-2.3 | Add test:harness to CI           | DONE   | -        | 34-2.2       | Already present in ci.yml (lines 66-67)      |

### Group 35: Release Finalization

| ID     | Task                  | Status | Agent    | Dependencies   | Notes                              |
| ------ | --------------------- | ------ | -------- | -------------- | ---------------------------------- |
| 35-3.1 | Version bump to 0.5.1 | DONE   | -        | 33-1.1, 34-2.2 | package.json already at 0.5.1      |
| 35-3.2 | Update CHANGELOG.md   | DONE   | OpenCode | 35-3.1         | Document v0.5.0 and v0.5.1 changes |

### Group 36: Call Edge Detection Improvements

**Context**: Benchmark shows only 636 call edges vs 10,411 import edges. Multiple call patterns are not detected by tree-sitter queries in `extractCalls.ts`. These tasks improve call graph completeness for better slice building.

**Files**:

- `src/indexer/treesitter/extractCalls.ts` - Tree-sitter call queries
- `src/indexer/indexer.ts` - Call resolution logic (lines 539-582)
- `src/indexer/ts/tsParser.ts` - Optional TS compiler API layer

| ID     | Task                                         | Status | Agent  | Dependencies | Priority | Effort |
| ------ | -------------------------------------------- | ------ | ------ | ------------ | -------- | ------ |
| 36-1.1 | Add computed property call detection         | DONE   | Claude | None         | HIGH     | LOW    |
| 36-1.2 | Unwrap await_expression for calls            | DONE   | Claude | None         | HIGH     | LOW    |
| 36-1.3 | Create unresolved edges for ambiguous calls  | DONE   | Claude | None         | HIGH     | LOW    |
| 36-1.4 | Add tagged_template_string detection         | DONE   | Claude | None         | MEDIUM   | LOW    |
| 36-1.5 | Detect calls inside arrow function callbacks | DONE   | Claude | None         | HIGH     | MEDIUM |
| 36-1.6 | Handle chained method calls                  | DONE   | Claude | None         | MEDIUM   | MEDIUM |
| 36-1.7 | Support optional chaining calls              | DONE   | Claude | None         | LOW      | LOW    |

---

## Task Details

### 33-1.1: Create LICENSE file

**Status**: DONE

**Priority**: CRITICAL (blocking npm publish)

**Resolution**: MIT LICENSE file already exists in project root (created 2026-01-29).

---

### 34-2.1: Document test execution strategy

**Status**: ✅ DONE

**Priority**: HIGH

**Context**: The project uses ESM (`"type": "module"`) and has `"test": "node --test"` in package.json. Need to decide whether tests run against:

- Built artifacts in `dist/` (preferred - matches shipped code)
- Source via `tsx` (faster iteration but different from production)

**Decision**: Dist-first strategy adopted (see TESTING.md)

**Acceptance Criteria**:

- ✅ Document decision in TESTING.md
- ✅ Verified test imports align with chosen strategy (already using dist/)
- ✅ No package.json updates needed (test scripts already correct)

**Implementation Details**:

- Created `TESTING.md` documenting dist-first strategy
- Verified test files already import from `dist/` with `.js` extensions
- Confirmed CI builds all artifacts before running tests
- Documented import patterns, examples, and troubleshooting

---

### 34-2.2: Make `npm test` pass E2E

**Priority**: HIGH

**Dependencies**: 34-2.1

**Acceptance Criteria**:

- `npm test` completes without errors
- All test files execute successfully
- Tests validate actual functionality (no `assert(true)` stubs)

**Known Test Files**:

- `tests/skeleton.test.ts`
- `tests/skeleton-determinism.test.ts`
- `tests/harness/runner.ts`
- `tests/harness/client-assertions.ts`

---

### 34-2.3: Add test:harness to CI

**Priority**: MEDIUM

**Dependencies**: 34-2.2

**File**: `.github/workflows/ci.yml`

**Acceptance Criteria**:

- Add step to run `npm run test:harness` in CI
- Ensure it runs after build completes
- Handle any Windows/Linux differences

**Implementation**:

```yaml
- name: Run test harness
  run: npm run test:harness
```

## Concurrency Rules

### Parallelizable Tasks (no dependencies)

These tasks can run in parallel with separate agents:

| Agent | Task                  |
| ----- | --------------------- |
| 1     | 33-1.1 (LICENSE file) |

### Sequential Tasks

These must complete in order:

```
34-2.1 -> 34-2.2 -> 34-2.3
                 \
                  -> 35-3.1 -> 35-3.2
                 /
33-1.1 ---------/
```

---

## Shared Patterns

### Import Order

1. Node.js built-ins
2. External packages
3. Internal absolute imports
4. Relative imports

### ESM Import Requirements

All TypeScript imports must include `.js` extension:

```typescript
// Correct
import { foo } from "./utils.js";
import { bar } from "../db/queries.js";

// Incorrect (will fail at runtime)
import { foo } from "./utils";
import { bar } from "../db/queries";
```

### Error Handling

- Use typed errors from `src/mcp/errors.ts`
- Never swallow errors silently
- Log with context via `src/util/logger.ts`

### Database Access

- All DB operations go through `src/db/queries.ts`
- Use transactions for multi-statement operations
- Handle Windows path normalization before storage

### File Paths

- Always use `src/util/paths.ts` helpers
- Store relative paths in DB, resolve to absolute on read
- Handle backslash/forward-slash conversion

### Naming Conventions

- Files: kebab-case (e.g., `file-scanner.ts`)
- Types/Interfaces: PascalCase (e.g., `SymbolCard`)
- Functions: camelCase (e.g., `buildGraphSlice`)
- Constants: SCREAMING_SNAKE_CASE (e.g., `MAX_WINDOW_LINES`)

---

## Key Files Reference

### Type Definitions

- `src/db/schema.ts` - Database row types
- `src/mcp/types.ts` - Domain types (SymbolCard, GraphSlice, DeltaPack, etc.)
- `src/policy/types.ts` - Policy engine types
- `src/config/types.ts` - Configuration types

### Configuration

- `config/sdlmcp.config.schema.json` - JSON Schema for config validation
- `config/sdlmcp.config.example.json` - Example configuration

### Database

- `/migrations/*.sql` - SQL migration files
- `src/db/db.ts` - SQLite connection and pragmas
- `src/db/queries.ts` - All database queries

### MCP Tools

| Tool Name               | Implementation          | Description                      |
| ----------------------- | ----------------------- | -------------------------------- |
| sdl.repo.register       | src/mcp/tools/repo.ts   | Register repository              |
| sdl.repo.status         | src/mcp/tools/repo.ts   | Get repo status                  |
| sdl.index.refresh       | src/mcp/tools/repo.ts   | Trigger re-indexing              |
| sdl.symbol.search       | src/mcp/tools/symbol.ts | Search symbols                   |
| sdl.symbol.getCard      | src/mcp/tools/symbol.ts | Get symbol card (ETag support)   |
| sdl.slice.build         | src/mcp/tools/slice.ts  | Build graph slice (handle/lease) |
| sdl.slice.refresh       | src/mcp/tools/slice.ts  | Delta-only refresh               |
| sdl.slice.spillover.get | src/mcp/tools/slice.ts  | Paged overflow fetch             |
| sdl.delta.get           | src/mcp/tools/delta.ts  | Get delta pack                   |
| sdl.code.needWindow     | src/mcp/tools/code.ts   | Request code window              |
| sdl.code.getSkeleton    | src/mcp/tools/code.ts   | Get skeleton IR                  |
| sdl.code.getHotPath     | src/mcp/tools/code.ts   | Get hot-path excerpt             |
| sdl.policy.get          | src/mcp/tools/policy.ts | Get policy settings              |
| sdl.policy.set          | src/mcp/tools/policy.ts | Update policy                    |

### CLI Commands

| Command | File                        | Description          |
| ------- | --------------------------- | -------------------- |
| init    | src/cli/commands/init.ts    | Initialize config    |
| doctor  | src/cli/commands/doctor.ts  | Validate environment |
| index   | src/cli/commands/index.ts   | Index repositories   |
| serve   | src/cli/commands/serve.ts   | Start MCP server     |
| version | src/cli/commands/version.ts | Show version         |

---

## Progress Log

| Timestamp  | Agent    | Action                       | Notes                                     |
| ---------- | -------- | ---------------------------- | ----------------------------------------- |
| 2026-01-29 | Claude   | Reorganized AGENTS.md        | Archived completed tasks to COMPLETED.md  |
| 2026-01-29 | Claude   | Created v0.5.1 task registry | 6 tasks remaining for release             |
| 2026-01-29 | OpenCode | Completed 34-2.1             | Documented dist-first test strategy       |
| 2026-01-29 | OpenCode | Completed 35-3.2             | Updated CHANGELOG.md for v0.5.1           |
| 2026-01-29 | Claude   | Verified 33-1.1 complete     | LICENSE file exists, removed debug logs   |
| 2026-01-29 | Claude   | Completed 34-2.2, 34-2.3     | Tests pass, CI already has harness step   |
| 2026-01-29 | Claude   | Added Group 36 tasks         | 7 call edge detection improvements        |
| 2026-01-29 | Claude   | Completed Group 36 (all 7)   | Call edges: 636→2,609 (+310% improvement) |
| 2026-02-08 | Codex    | Planned v0.6 execution       | Added v0.6 PRD, cloud explore PRD, and V06 task board |

For historical progress log, see [COMPLETED.md](./COMPLETED.md#progress-log-historical).
