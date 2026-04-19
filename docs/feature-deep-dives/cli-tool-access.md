# CLI Tool Access

**Access 30 SDL-MCP action aliases directly from the command line without running an MCP transport.**

The `sdl-mcp tool` command executes the same handler layer used by the MCP server, but it does not expose the entire runtime surface. It covers the CLI action definitions in [`src/cli/commands/tool-actions.ts`](../../src/cli/commands/tool-actions.ts), which currently includes 30 aliases across query, code, repo, and agent namespaces.

---

## Quick Start

```bash
# List available actions
sdl-mcp tool --list

# Search for symbols
sdl-mcp tool symbol.search --repo-id my-repo --query "handleAuth"

# Get a symbol card
sdl-mcp tool symbol.getCard --repo-id my-repo --symbol-id "file:src/server.ts::MCPServer"

# Build a task-scoped graph slice
sdl-mcp tool slice.build --repo-id my-repo --task-text "debug auth flow" --max-cards 50

# Show action-specific help
sdl-mcp tool symbol.search --help
```

---

## How It Works

The CLI dispatcher bypasses MCP transport setup. It parses flags, loads config, initializes Ladybug, resolves the action, validates arguments with the same Zod schemas used by the MCP server, and then formats the result for terminal output.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Cmd["sdl-mcp tool symbol.search --query auth"]
    Parse["CLI arg parser<br/>type coercion + aliases"]
    Init["Config + DB init<br/>same startup path as MCP server"]
    Route["Action router + Zod validation<br/>same handler functions"]
    Output["Output formatter<br/>json | json-compact | pretty | table"]

    Cmd e1@--> Parse
    Parse e2@--> Init
    Init e3@--> Route
    Route e4@--> Output

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

---

## Current Action Surface

Run `sdl-mcp tool --list` to inspect the current aliases grouped by namespace.

### Query

| Action | Description |
| :----- | :---------- |
| `symbol.search` | Search symbols by name or summary |
| `symbol.getCard` | Get a symbol card by ID |
| `slice.build` | Build a graph slice for a task |
| `slice.refresh` | Refresh an existing slice handle |
| `slice.spillover.get` | Fetch paginated spillover cards |
| `delta.get` | Get a delta pack between versions |
| `pr.risk.analyze` | Analyze PR risk and blast radius |

### Code

| Action | Description |
| :----- | :---------- |
| `code.needWindow` | Request a policy-gated raw code window |
| `code.getSkeleton` | Get skeleton structure without full bodies |
| `code.getHotPath` | Get lines matching specific identifiers |

### Repo

| Action | Description |
| :----- | :---------- |
| `repo.register` | Register a repository |
| `repo.status` | Get repository status |
| `repo.overview` | Get a token-efficient repository overview |
| `index.refresh` | Trigger indexing |
| `scip.ingest` | Ingest a SCIP index |
| `policy.get` | Read the current policy |
| `policy.set` | Update the current policy |
| `usage.stats` | Read token usage statistics |
| `file.read` | Read non-indexed files through SDL |

### Agent

| Action | Description |
| :----- | :---------- |
| `agent.feedback` | Record which symbols were useful or missing |
| `agent.feedback.query` | Query aggregated feedback |
| `buffer.push` | Push live buffer updates |
| `buffer.checkpoint` | Force a live-buffer checkpoint |
| `buffer.status` | Inspect live-buffer state |
| `runtime.execute` | Run a sandboxed subprocess |
| `runtime.queryOutput` | Query stored runtime output |
| `memory.store` | Store a development memory |
| `memory.query` | Search development memories |
| `memory.remove` | Remove a development memory |
| `memory.surface` | Surface relevant memories |

`sdl-mcp tool` does not expose Code Mode-only tools (`sdl.context`, `sdl.manual`, `sdl.workflow`), and it currently does not expose `file.write`.

---

## Output Formats

Use `--output-format` to choose how results are printed:

```bash
# Default: indented JSON
sdl-mcp tool repo.status --repo-id my-repo

# Compact JSON for scripts
sdl-mcp tool repo.status --repo-id my-repo --output-format json-compact

# Human-readable pretty output
sdl-mcp tool symbol.search --repo-id my-repo --query "auth" --output-format pretty

# Table output for list-shaped data
sdl-mcp tool agent.feedback.query --repo-id my-repo --output-format table
```

Supported values are `json`, `json-compact`, `pretty`, and `table`.

---

## Argument Handling

The CLI parser supports the same common aliases accepted by MCP requests, including `--repo-id`, `--root-path`, `--symbol-id`, `--symbol-ids`, `--from-version`, `--to-version`, and `--slice-handle`.

For actions that accept nested `budget` objects, the CLI provides flat convenience flags:

```bash
sdl-mcp tool slice.build --repo-id my-repo --task-text "debug" \
  --max-cards 50 --max-tokens 10000
```

That becomes:

```json
{ "budget": { "maxCards": 50, "maxEstimatedTokens": 10000 } }
```

If stdin provides JSON input, CLI flags override the piped values.

---

## Examples

### Debugging

```bash
sdl-mcp tool symbol.search --query "validateToken" --output-format pretty
sdl-mcp tool symbol.getCard --symbol-id "file:src/auth/jwt.ts::validateToken"
sdl-mcp tool slice.build --task-text "debug token validation failure" --max-cards 20
sdl-mcp tool code.getSkeleton --file src/auth/jwt.ts --output-format pretty
sdl-mcp tool code.getHotPath --symbol-id "file:src/auth/jwt.ts::validateToken" \
  --identifiers "verifySignature,checkExpiry"
```

### PR Review

```bash
sdl-mcp tool pr.risk.analyze --from-version v22 --to-version v23
sdl-mcp tool delta.get --from-version v22 --to-version v23
sdl-mcp summary "changes in v23" --format markdown --repo-id my-repo
```

### CI

```bash
sdl-mcp tool repo.register --repo-id ci-build --root-path .
sdl-mcp tool index.refresh --repo-id ci-build --mode full
sdl-mcp tool runtime.execute --runtime shell --code "npm test" --timeout-ms 30000 --output-mode minimal
```

---

## Architecture Notes

The direct CLI surface is implemented by four modules:

| Module | File | Responsibility |
| :----- | :--- | :------------- |
| Action definitions | `src/cli/commands/tool-actions.ts` | Declares the 30 CLI-visible aliases |
| Arg parser | `src/cli/commands/tool-arg-parser.ts` | Maps flags to handler fields and coerces types |
| Dispatcher | `src/cli/commands/tool-dispatch.ts` | Loads config, resolves `repoId`, routes actions, and handles errors |
| Output formatter | `src/cli/commands/tool-output.ts` | Formats results as JSON, compact JSON, pretty, or table output |

The dispatcher reuses the gateway action map for execution, so the CLI and MCP server share the same handlers and core validation logic. The important distinction is surface area: the CLI alias list is defined separately and therefore can lag or intentionally omit parts of the full MCP catalog.

---

## Limitations

- `buffer.*` actions require a running MCP server with live indexing. In CLI mode they typically return limited or empty results.
- `file.write` is MCP-only today and is not available through `sdl-mcp tool`.
- Code Mode tools are separate from the direct CLI alias surface.
- Each invocation initializes config and the graph database, so high-frequency automation is better served by an MCP server over HTTP or stdio.

[Back to README](../../README.md)
