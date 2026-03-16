# Code Mode

**Batch multiple SDL-MCP operations in a single round-trip with `$N` references between steps — the next level of token optimization beyond gateway mode.**

Code Mode introduces two new tools (`sdl.manual` + `sdl.chain`) that let LLMs batch entire context retrieval pipelines into a single tool call, using structured JSON call chains with inter-step references.

---

## The Opportunity

Gateway mode reduced `tools/list` overhead by 81%. Code Mode reduces **per-operation overhead** by eliminating multi-turn round trips. SDL-MCP's context ladder (search → card → skeleton → hotPath → window) is a natural sequential pipeline — exactly what call chains excel at.

```
Without Code Mode:
  Turn 1: sdl.query { action: "symbol.search", query: "auth" }      → ~500ms
  Turn 2: sdl.query { action: "symbol.getCard", symbolId: "..." }   → ~500ms
  Turn 3: sdl.code  { action: "code.getSkeleton", symbolId: "..." } → ~500ms
  = 3 round trips, ~1500ms total

With Code Mode:
  Turn 1: sdl.chain { steps: [search, getCard, getSkeleton] }       → ~500ms
  = 1 round trip, ~500ms total
```

## How It Works

### The Manual (`sdl.manual`)

Call once per session. Returns a compact TypeScript API reference (~1,000 tokens) listing all available functions with their parameters and return types. This replaces thousands of tokens of JSON Schema with an efficient function signature format.

### The Chain (`sdl.chain`)

Batch multiple operations in a single call. Each step specifies a function name and arguments, with `$N` references to pass results between steps.

#### Chain Request Format

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

### `$N` Reference Syntax

Reference prior step results using `$N` notation:

| Reference                | Resolves To                            |
| ------------------------ | -------------------------------------- |
| `$0`                     | Entire result of step 0                |
| `$0.symbols`             | The `symbols` field of step 0's result |
| `$0.symbols[0].symbolId` | First symbol's ID from step 0          |
| `$1.card.signature`      | The signature field from step 1's card |

**Rules:**

- Maximum 4 path segments after `$N`
- Forward references are rejected (step 1 cannot reference `$2`)
- Full-value references preserve type (objects stay objects, arrays stay arrays)
- Embedded references in strings are interpolated: `"prefix $0.name suffix"`

## Features

### Budget Tracking

Chain-level budget wraps per-step policy enforcement:

- **Token budget**: Stop when cumulative estimated tokens exceed limit
- **Step budget**: Stop after N steps
- **Duration budget**: Stop after wall-clock time limit
- Request budgets can only be MORE restrictive than config defaults

### Context Ladder Validation

Validates that steps follow the recommended escalation order per symbol:

```
Rung 0: symbol.search
Rung 1: symbol.getCard / symbol.getCards / slice.build
Rung 2: code.getSkeleton
Rung 3: code.getHotPath
Rung 4: code.needWindow
```

Three modes:

- `off`: No validation
- `warn` (default): Warnings in response but chain executes
- `enforce`: Stronger warnings (full enforcement planned)

### Cross-Step ETag Caching

Automatic ETag management within chains:

- ETags extracted from `symbolGetCard` / `symbolGetCards` results
- Automatically injected as `ifNoneMatch` in subsequent card requests
- ETag cache returned in response for cross-chain persistence via `seed()`

### Error Handling

Two policies:

- `continue` (default): Mark failed step as error, continue remaining steps
- `stop`: Mark failed step as error, mark remaining as skipped

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

| Field                | Type    | Default  | Description                                           |
| -------------------- | ------- | -------- | ----------------------------------------------------- |
| `enabled`            | boolean | `false`  | Enable Code Mode tools                                |
| `exclusive`          | boolean | `false`  | Only register Code Mode tools (suppress gateway/flat) |
| `maxChainSteps`      | integer | `20`     | Max steps per chain                                   |
| `maxChainTokens`     | integer | `50000`  | Max total result tokens per chain                     |
| `maxChainDurationMs` | integer | `60000`  | Max wall-clock time per chain                         |
| `ladderValidation`   | string  | `"warn"` | Ladder check mode: off, warn, enforce                 |
| `etagCaching`        | boolean | `true`   | Auto-inject ETags for card requests                   |

## Deployment Modes

| Mode                | Tools Registered                | Use When               |
| ------------------- | ------------------------------- | ---------------------- |
| Code Mode disabled  | Gateway (4) or Flat (29)        | Default behavior       |
| Code Mode + Gateway | Gateway (4) + Code Mode (2) = 6 | Best of both worlds    |
| Code Mode + Flat    | Flat (29) + Code Mode (2) = 31  | Maximum compatibility  |
| Code Mode exclusive | Code Mode (2) only              | Minimum token overhead |

## Token Savings Comparison

| Mode                | tools/list tokens    | Per-operation overhead     | Best for               |
| ------------------- | -------------------- | -------------------------- | ---------------------- |
| Flat (29 tools)     | ~4,250               | 1 round-trip per operation | Maximum compatibility  |
| Gateway (4 tools)   | ~725                 | 1 round-trip per operation | Most agents            |
| Code Mode (2 tools) | ~300 + ~1,000 manual | 1 round-trip per pipeline  | Token-optimized agents |
| Code Mode exclusive | ~300 + ~1,000 manual | 1 round-trip per pipeline  | Minimum overhead       |

## Example Workflows

### Debug Workflow (3 steps, 1 round-trip)

```json
{
  "repoId": "my-repo",
  "steps": [
    { "fn": "symbolSearch", "args": { "query": "handleAuth", "limit": 5 } },
    { "fn": "symbolGetCard", "args": { "symbolId": "$0.symbols[0].symbolId" } },
    {
      "fn": "codeHotPath",
      "args": {
        "symbolId": "$1.card.symbolId",
        "identifiersToFind": ["token", "validate"]
      }
    }
  ],
  "budget": { "maxTotalTokens": 3000 }
}
```

### Implementation Workflow (4 steps, 1 round-trip)

```json
{
  "repoId": "my-repo",
  "steps": [
    { "fn": "repoOverview", "args": { "level": "stats" } },
    { "fn": "symbolSearch", "args": { "query": "UserService", "limit": 10 } },
    { "fn": "symbolGetCard", "args": { "symbolId": "$1.symbols[0].symbolId" } },
    {
      "fn": "sliceBuild",
      "args": {
        "entrySymbols": ["$2.card.symbolId"],
        "budget": { "maxCards": 20 }
      }
    }
  ]
}
```
