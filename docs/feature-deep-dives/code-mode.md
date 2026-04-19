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
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Agent["Agent"]

    subgraph "Universal + Code Mode Surface"
        AS["sdl.action.search<br/>Discovery"]
        MN["sdl.manual<br/>Reference"]
        CTX["sdl.context<br/>Task-shaped context"]
        WF["sdl.workflow<br/>Multi-step operations"]
    end

    Agent e1@-->|"1. What should I use?"| AS
    AS e2@-->|"ranked actions + hints"| Agent
    Agent e3@-->|"2. Show me the narrow API"| MN
    MN e4@-->|"compact manual"| Agent
    Agent e5@-->|"3a. Understand code"| CTX
    Agent e6@-->|"3b. Execute a pipeline"| WF

    subgraph "sdl.workflow Example"
        S1["Step 0: symbolSearch"]
        S2["Step 1: runtimeExecute"]
        S3["Step 2: dataTemplate"]
        S1 e7@-->|"$0"| S2
        S2 e8@-->|"$1"| S3
    end

    WF e9@--> S1
    CTX e10@-->|"finalEvidence + metrics"| Agent
    S3 e11@-->|"step results + budget + traces"| Agent

    style AS fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43
    style MN fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43
    style CTX fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style WF fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11 animate;
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
