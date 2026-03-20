# CLI Tool Access

**Access all 30 SDL-MCP tool actions directly from the command line — no MCP server, transport, or SDK required.**

The `sdl-mcp tool` command invokes MCP tool handlers directly, giving you full access to SDL-MCP's capabilities from shell scripts, CI pipelines, and interactive terminal sessions.

---

## Quick Start

```bash
# List all available actions
sdl-mcp tool --list

# Search for symbols
sdl-mcp tool symbol.search --repo-id my-repo --query "handleAuth"

# Get a symbol card
sdl-mcp tool symbol.getCard --repo-id my-repo --symbol-id "file:src/server.ts::MCPServer"

# Build a task-scoped graph slice
sdl-mcp tool slice.build --repo-id my-repo --task-text "debug auth flow" --max-cards 50

# Get action-specific help
sdl-mcp tool symbol.search --help
```

---

## How It Works

The CLI tool dispatcher bypasses the MCP server/transport layer entirely. Instead, it:

1. **Parses CLI flags** into typed arguments using action definitions
2. **Loads config and initializes the graph DB** (same as the MCP server)
3. **Routes directly** to the same handler functions the MCP server uses
4. **Validates** with the same Zod schemas
5. **Formats output** in your choice of format

```
  sdl-mcp tool symbol.search --query "auth"
       │
       ▼
  ┌─────────────────────┐
  │ CLI Arg Parser       │  --query → { query: "auth" }
  │ (type coercion)      │  --limit → number, --tags → string[]
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ Config + DB Init     │  Same config loading as MCP server
  │ + repoId resolution  │  Auto-resolves repoId from cwd
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ Gateway Router       │  Same handler functions
  │ + Zod Validation     │  Same schemas
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ Output Formatter     │  json | json-compact | pretty | table
  └─────────────────────┘
```

---

## All 30 Actions

Run `sdl-mcp tool --list` to see all actions grouped by namespace:

### Query — Read-only intelligence queries

| Action | Description |
|:-------|:------------|
| `symbol.search` | Search for symbols by name or summary |
| `symbol.getCard` | Get a single symbol card by ID |
| `symbol.getCards` | Batch fetch symbol cards for multiple IDs |
| `slice.build` | Build a graph slice for a task context |
| `slice.refresh` | Refresh an existing slice handle (delta only) |
| `slice.spillover.get` | Fetch overflow symbols with pagination |
| `delta.get` | Get delta pack between two versions |
| `context.summary` | Generate token-bounded context summary |
| `pr.risk.analyze` | Analyze PR risk with blast radius |

### Code — Gated raw code access

| Action | Description |
|:-------|:------------|
| `code.needWindow` | Request policy-gated raw code window |
| `code.getSkeleton` | Get skeleton view (signatures + control flow) |
| `code.getHotPath` | Get lines matching specific identifiers |

### Repo — Repository lifecycle

| Action | Description |
|:-------|:------------|
| `repo.register` | Register a repository for indexing |
| `repo.status` | Get repository status information |
| `repo.overview` | Get codebase overview with directory summaries |
| `index.refresh` | Trigger full or incremental re-indexing |
| `policy.get` | Read current gating policy |
| `policy.set` | Update policy configuration |

### Agent — Agentic + live-edit operations

| Action | Description |
|:-------|:------------|
| `agent.orchestrate` | Autonomous task execution with budget control |
| `agent.feedback` | Record which symbols were useful/missing |
| `agent.feedback.query` | Query aggregated feedback statistics |
| `buffer.push` | Push editor buffer updates (limited in CLI) |
| `buffer.checkpoint` | Force checkpoint (limited in CLI) |
| `buffer.status` | Get buffer status (limited in CLI) |
| `memory.store` | Store a development memory |
| `memory.query` | Query development memories |
| `memory.remove` | Remove a development memory |
| `memory.surface` | Auto-surface relevant memories |
| `runtime.execute` | Execute command in sandboxed subprocess |

> **Note:** `buffer.*` actions require a running MCP server with live indexing and will return limited results in CLI mode.

---

## Output Formats

Control output with `--output-format`:

```bash
# Default: indented JSON (human-readable, machine-parseable)
sdl-mcp tool repo.status --repo-id my-repo

# Compact JSON (one line, ideal for piping)
sdl-mcp tool repo.status --repo-id my-repo --output-format json-compact

# Pretty: human-readable formatting with tables and labels
sdl-mcp tool symbol.search --repo-id my-repo --query "auth" --output-format pretty

# Table: columnar output for list-like results
sdl-mcp tool agent.feedback.query --repo-id my-repo --output-format table
```

### Pretty format examples

**Symbol search:**
```
Found 3 symbol(s):

  NAME              KIND       FILE
  ─────────────────  ─────────  ──────────────
  handleAuth        function   src/auth.ts
  AuthService       class      src/auth.ts
  AuthMiddleware    class      src/middleware.ts
```

**Repo status:**
```
Repository: my-repo
  Root Path:       /path/to/repo
  Files Indexed:   142
  Symbols Indexed: 1,847
  Latest Version:  v23
  Last Indexed:    2026-03-14T19:00:00Z
  Health Score:    92
```

**Slice build:**
```
Slice built:
  Cards: 12
  Edges: 18
  Handle: slice-abc123
```

---

## Argument Types

The CLI automatically coerces flag values to the expected types:

| Type | CLI Syntax | Example |
|:-----|:-----------|:--------|
| `string` | `--flag value` | `--repo-id my-repo` |
| `number` | `--flag 42` | `--limit 20` |
| `boolean` | `--flag` | `--semantic` |
| `string[]` | `--flag a,b,c` | `--entry-symbols "sym1,sym2"` |
| `json` | `--flag '{"key":"val"}'` | `--policy-patch '{"maxWindowLines":200}'` |

### Budget flags

Actions that accept a `budget` object use flat flags for convenience:

```bash
# These flat flags:
sdl-mcp tool slice.build --repo-id my-repo --task-text "debug" \
  --max-cards 50 --max-tokens 10000

# Are merged into:
# { budget: { maxCards: 50, maxEstimatedTokens: 10000 } }
```

---

## Stdin JSON Piping

Pipe JSON arguments via stdin. CLI flags override piped values:

```bash
# Pipe full args from stdin
echo '{"repoId":"my-repo","query":"auth","limit":5}' | sdl-mcp tool symbol.search

# Mix stdin + CLI flags (CLI wins)
echo '{"repoId":"my-repo","limit":100}' | sdl-mcp tool symbol.search --query "auth" --limit 5
# Result: query="auth", limit=5 (CLI wins), repoId="my-repo" (from stdin)

# Chain commands
sdl-mcp tool symbol.search --repo-id my-repo --query "auth" --output-format json-compact \
  | jq '.results[0].symbolId' \
  | xargs -I{} sdl-mcp tool symbol.getCard --repo-id my-repo --symbol-id {}
```

---

## Auto-Resolution

### repoId

You don't always need to specify `--repo-id`. The CLI auto-resolves it by:

1. **Checking CLI flags and stdin** — explicit `--repo-id` always wins
2. **Matching cwd** — if your current directory is inside a configured repo's root path
3. **Single-repo fallback** — if only one repo is configured, it's used automatically

```bash
# Inside /path/to/my-repo (which is configured):
sdl-mcp tool symbol.search --query "auth"
# ✅ repoId auto-resolved to "my-repo"
```

### Typo suggestions

Mistyped action names get suggestions:

```bash
$ sdl-mcp tool symbol.sear
Error: unknown action "symbol.sear". Did you mean: symbol.search?. Run: sdl-mcp tool --list
```

---

## Examples by Workflow

### Debugging

```bash
# 1. Search for the relevant symbol
sdl-mcp tool symbol.search --query "validateToken" --output-format pretty

# 2. Get its card (signature, deps, summary)
sdl-mcp tool symbol.getCard --symbol-id "file:src/auth/jwt.ts::validateToken"

# 3. Build a task-scoped slice
sdl-mcp tool slice.build --task-text "debug token validation failure" --max-cards 20

# 4. Get skeleton of the class
sdl-mcp tool code.getSkeleton --file src/auth/jwt.ts --output-format pretty

# 5. Get hot-path for specific identifiers
sdl-mcp tool code.getHotPath --symbol-id "file:src/auth/jwt.ts::validateToken" \
  --identifiers "verifySignature,checkExpiry"
```

### PR Review

```bash
# Analyze PR risk between versions
sdl-mcp tool pr.risk.analyze --from-version v22 --to-version v23

# Get the semantic delta
sdl-mcp tool delta.get --from-version v22 --to-version v23

# Generate a context summary for the reviewer
sdl-mcp tool context.summary --query "changes in v23" --format markdown
```

### CI/CD Integration

```bash
# Register and index in CI
sdl-mcp tool repo.register --repo-id ci-build --root-path .
sdl-mcp tool index.refresh --repo-id ci-build --mode full

# Run PR risk analysis and fail on high risk
RISK=$(sdl-mcp tool pr.risk.analyze --from-version $BASE_SHA --to-version $HEAD_SHA \
  --output-format json-compact | jq '.overallRisk')
if [ "$RISK" -gt 75 ]; then
  echo "High risk PR detected: $RISK"
  exit 1
fi
```

### Scripting

```bash
# Export all symbols to a file
sdl-mcp tool symbol.search --query "" --limit 1000 --output-format json-compact > symbols.json

# Batch fetch cards for specific symbols
sdl-mcp tool symbol.getCards --symbol-ids "sym1,sym2,sym3" --output-format json > cards.json

# Run a sandboxed command
sdl-mcp tool runtime.execute --runtime shell --code "npm test" --timeout-ms 30000
```

---

## Architecture

The CLI tool access feature is composed of four modules:

| Module | File | Responsibility |
|:-------|:-----|:---------------|
| **Action Definitions** | `src/cli/commands/tool-actions.ts` | 30 action definitions with arg specs, types, and examples |
| **Arg Parser** | `src/cli/commands/tool-arg-parser.ts` | Flag→field mapping, type coercion, budget merging, required validation |
| **Dispatcher** | `src/cli/commands/tool-dispatch.ts` | Config/DB init, repoId resolution, handler routing, error handling |
| **Output Formatter** | `src/cli/commands/tool-output.ts` | JSON, compact JSON, pretty, and table output with action-specific formatting |

The dispatcher reuses the **gateway router** (`src/gateway/router.ts`) which maps action names to the same `{ schema, handler }` pairs used by the MCP server. This means CLI and MCP always execute identical code paths.

---

## Configuration

No additional configuration is needed. The `tool` command uses the same config file as all other SDL-MCP commands:

```bash
# Use default config resolution
sdl-mcp tool symbol.search --query "auth"

# Override config path
sdl-mcp tool --config /path/to/sdl-mcp.json symbol.search --query "auth"
```

Config lookup order: `--config` → `SDL_CONFIG` env → cwd local config → user-global config → package fallback.

---

## Limitations

- **`buffer.*` actions** require an active MCP server with live indexing. In CLI mode they will return errors or empty results.
- **No streaming** — results are returned after full execution (no partial updates).
- **Single invocation** — each `sdl-mcp tool` call initializes config + DB. For high-frequency scripting, consider using the MCP server via HTTP transport instead.
