# Code Mode

**Use SDL-MCP Code Mode to keep discovery, context retrieval, and multi-step execution inside SDL instead of falling back to token-heavy native tools.**

Code Mode is built around one clear separation of responsibility:

- `sdl.action.search` is the universal discovery surface.
- `sdl.manual` loads a compact API subset.
- `sdl.context` handles task-shaped code understanding.
- `sdl.workflow` handles multi-step operations.

If you remember only one rule, make it this one: use `sdl.context` first for `explain`, `debug`, `review`, and most `implement` requests. Use `sdl.workflow` only when the work is genuinely procedural.

---

## What Code Mode Solves

Without Code Mode, agents waste tokens on:

- large tool lists
- repeated schema exposure
- serial context gathering
- native shell and file calls that SDL could answer directly

Code Mode keeps those flows inside SDL-MCP:

1. discover the right surface with `sdl.action.search`
2. load a narrow API slice with `sdl.manual`
3. route understanding work to `sdl.context`
4. route execution pipelines to `sdl.workflow`

---

## Tool Surface

### `sdl.action.search`

Use this first when the right SDL action is unclear.

It returns ranked actions with optional schema summaries, examples, prerequisites, and recommended next steps.

Use `offset` with `limit` to page through large result sets such as `query: "*"`.

### `sdl.manual`

Use this when you know the rough area and want a compact manual instead of the full API surface.

Supported filters:

- `query` for text filtering
- `actions` for an exact subset
- `format` for `typescript`, `markdown`, or `json`
- `includeSchemas` / `includeExamples` for richer output

### `sdl.context`

Use this for task-shaped context retrieval inside Code Mode.

It mirrors `sdl.context`, but it sits next to `sdl.manual` and `sdl.workflow` so an agent can stay on the Code Mode surface after discovery. Start here for:

- `explain`
- `debug`
- `review`
- `implement` when the immediate need is understanding existing code

### `sdl.workflow`

Use this for multi-step operations that would otherwise require multiple SDL calls.

Good fits:

- `runtimeExecute` pipelines
- data transforms
- batch mutations
- reusable multi-step lookup and shaping flows

Bad fits:

- single actions
- explain/debug/review context retrieval
- “figure out what this code does” questions

---

## Routing Guide

| Request shape | Start with | Why |
|:--------------|:-----------|:----|
| Explain a symbol or module | `sdl.context` | Returns task-shaped evidence without hand-building the ladder |
| Debug a bug or trace behavior | `sdl.context` | Chooses `card`, `skeleton`, `hotPath`, and raw follow-ups only when needed |
| Review code or inspect risk | `sdl.context` | Gives compact review-oriented evidence first |
| Learn a pattern before implementing | `sdl.context` | Gets structural context with less overhead than a workflow |
| Run tests, lint, or diagnostics | `sdl.workflow` | Best for `runtimeExecute` plus follow-up parsing |
| Shape or filter previous results | `sdl.workflow` | Internal transforms avoid wasting model tokens |
| Batch multiple dependent operations | `sdl.workflow` | `$N` references keep everything in one round trip |

---

## Architecture

```mermaid
%%{init: {"theme":"base","themeVariables":{"primaryColor":"#e8fff1","primaryBorderColor":"#157f5b","primaryTextColor":"#102a43","secondaryColor":"#eef6ff","secondaryBorderColor":"#2563eb","tertiaryColor":"#fff4d6","tertiaryBorderColor":"#b45309","lineColor":"#157f5b","fontFamily":"Trebuchet MS, Arial"},"flowchart":{"curve":"basis"}}}%%
flowchart TD
    Agent["Agent"]

    subgraph "Universal + Code Mode Surface"
        AS["sdl.action.search<br/>Discovery"]
        MN["sdl.manual<br/>Reference"]
        CTX["sdl.context<br/>Task-shaped context"]
        WF["sdl.workflow<br/>Multi-step operations"]
    end

    Agent -->|"1. What should I use?"| AS
    AS -->|"ranked actions + hints"| Agent
    Agent -->|"2. Show me the narrow API"| MN
    MN -->|"compact manual"| Agent
    Agent -->|"3a. Understand code"| CTX
    Agent -->|"3b. Execute a pipeline"| WF

    subgraph "sdl.workflow Example"
        S1["Step 0: symbolSearch"]
        S2["Step 1: runtimeExecute"]
        S3["Step 2: dataTemplate"]
        S1 -->|"$0"| S2
        S2 -->|"$1"| S3
    end

    WF --> S1
    CTX -->|"finalEvidence + metrics"| Agent
    S3 -->|"step results + budget + traces"| Agent

    style AS fill:#cce5ff,stroke:#004085
    style MN fill:#fff3cd,stroke:#ffc107
    style CTX fill:#d4edda,stroke:#28a745
    style WF fill:#f8d7da,stroke:#721c24
```

---

## Workflow Anatomy

`sdl.workflow` executes sequential steps that reference earlier results through `$N.path` expressions.

References also support optional chaining such as `$0.results[1]?.symbolId`, which resolves to `undefined` instead of failing when the indexed value is missing.

Each step has:

- `fn`: action or internal transform name
- `args`: arguments object

Internal transforms include:

- `dataPick`
- `dataMap`
- `dataFilter`
- `dataSort`
- `dataTemplate`

The workflow engine also provides:

- budget tracking
- context-ladder validation
- cross-step ETag caching
- optional execution traces

---

## Configuration

```json
{
  "codeMode": {
    "enabled": true,
    "exclusive": true,
    "maxWorkflowSteps": 20,
    "maxWorkflowTokens": 50000,
    "maxWorkflowDurationMs": 60000,
    "ladderValidation": "warn",
    "etagCaching": true
  }
}
```

### Registration modes

| Mode | Registered tools |
|:-----|:-----------------|
| Disabled | Base flat or gateway tools, plus universal `sdl.action.search` and `sdl.info` |
| Enabled + gateway | Gateway tools plus `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.workflow` |
| Enabled + flat | Flat tools plus `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.workflow` |
| Exclusive | `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.workflow` only |

---

## Recommended Agent Flow

For SDL-first agents:

1. `sdl.repo.status`
2. `sdl.action.search` when the right surface is unclear
3. `sdl.manual(query|actions)` when a compact API slice helps
4. `sdl.context` for explain/debug/review/implement context retrieval
5. `sdl.workflow` for runtime execution, data shaping, batch mutations, and other procedural pipelines
6. `runtimeExecute` inside `sdl.workflow` for repo-local build, test, lint, or diagnostics

This is the intended path for enforced agent setups where SDL-MCP replaces token-heavy default tools whenever possible.

---

## Related Docs

- [Agent Context](./agent-context.md)
- [Context Modes](./context-modes.md)
- [Runtime Execution](./runtime-execution.md)
- [Tool Gateway](./tool-gateway.md)
- [Governance & Policy](./governance-policy.md)

[Back to README](../../README.md)
