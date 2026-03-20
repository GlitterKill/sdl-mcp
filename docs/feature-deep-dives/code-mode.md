# Code Mode

**Use SDL-MCP Code Mode to reduce tool-list overhead, collapse multi-step workflows into one round trip, and keep code understanding inside SDL instead of falling back to token-heavy native tools.**

Code Mode now exposes three complementary tools:

- `sdl.action.search` for discovery
- `sdl.manual` for focused reference
- `sdl.chain` for execution

Together they let agents discover the right SDL action, load only the relevant interface details, and execute a full lookup or runtime workflow in one call.

---

## What It Solves

Without Code Mode, agents often spend tokens on:

- large tool lists
- repeated schema exposure
- multiple round trips for sequential lookups
- native shell and file tools that SDL could replace

Code Mode keeps those workflows inside SDL-MCP:

1. Discover the right action with `sdl.action.search`
2. Load only the relevant API subset with `sdl.manual`
3. Execute the workflow with `sdl.chain`

---

## Tool Surface

### `sdl.action.search`

Use this first when the right SDL action is unclear.

Example:

```json
{
  "query": "find auth symbol and inspect code structure",
  "limit": 5,
  "includeSchemas": true
}
```

This returns a ranked subset of actions, with optional schema and example metadata.

### `sdl.manual`

Use this when you already know the rough area and want a compact manual instead of the full API surface.

Supported patterns:

- `query` to filter by text
- `actions` to request an exact subset
- `format` to choose `typescript`, `markdown`, or `json`
- `includeSchemas` / `includeExamples` for richer output

Example:

```json
{
  "actions": ["symbol.search", "symbol.getCard", "slice.build"],
  "format": "typescript",
  "includeExamples": true
}
```

### `sdl.chain`

Use this for any multi-step workflow that would otherwise require multiple SDL calls.

Example:

```json
{
  "repoId": "my-repo",
  "steps": [
    { "fn": "symbolSearch", "args": { "query": "handleAuth", "limit": 3 } },
    { "fn": "symbolGetCard", "args": { "symbolId": "$0.symbols[0].symbolId" } },
    { "fn": "codeSkeleton", "args": { "symbolId": "$1.card.symbolId" } }
  ],
  "budget": { "maxTotalTokens": 4000 },
  "onError": "continue"
}
```

---

## Current Features

### Result piping

Use `$N.path` references to feed step results into later steps.

### Internal transforms

`sdl.chain` supports chain-only data shaping without opening a general-purpose VM. Use internal transform steps such as:

- `dataPick`
- `dataMap`
- `dataFilter`
- `dataSort`
- `dataTemplate`

These are useful for fetch-shape-summarize workflows where the model would otherwise waste tokens interpreting raw payloads.

### Traces

`sdl.chain` supports opt-in traces for debugging and prompt construction. Trace output can include:

- per-step summaries
- resolved argument previews
- schema summaries
- examples
- bounded result previews

### Context ladder validation

Chains still honor SDL-MCP’s escalation model. Code Mode does not bypass policy or proof-of-need gating.

---

## Configuration

```json
{
  "codeMode": {
    "enabled": false,
    "exclusive": false,
    "maxChainSteps": 20,
    "maxChainTokens": 50000,
    "maxChainDurationMs": 60000,
    "ladderValidation": "warn",
    "etagCaching": true
  }
}
```

### Registration modes

| Mode | Registered tools |
|:-----|:-----------------|
| Disabled | Gateway or flat tools only |
| Enabled + gateway | Gateway tools plus `sdl.action.search`, `sdl.manual`, `sdl.chain` |
| Enabled + flat | Flat tools plus `sdl.action.search`, `sdl.manual`, `sdl.chain` |
| Exclusive | `sdl.action.search`, `sdl.manual`, `sdl.chain` only |

---

## Recommended Agent Workflow

For SDL-first agents:

1. `sdl.repo.status`
2. `sdl.action.search`
3. `sdl.manual(query|actions)`
4. `sdl.chain`
5. `runtimeExecute` inside `sdl.chain` for repo-local build, test, lint, or diagnostics

This is the intended path for enforced agent setups where SDL-MCP should replace token-heavy default tools whenever possible.
