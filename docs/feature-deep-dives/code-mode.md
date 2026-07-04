# Code Mode

**Use SDL-MCP Code Mode to keep discovery, context retrieval, and multi-step execution inside SDL instead of falling back to token-heavy native tools.**

Code Mode is built around one clear separation of responsibility:

- `sdl.action.search` is the universal discovery surface.
- `sdl.manual` loads a compact API subset.
- `sdl.context` handles task-shaped code understanding.
- `sdl.retrieve` handles one exact retrieval step.
- `sdl.workflow` handles multi-step operations.
- `sdl.file` handles file reads, writes, edits, and gated source windows.

If you remember only one rule, make it this one: use `sdl.context` first for `explain`, `debug`, `review`, and most `implement` requests. Use `sdl.retrieve` for one exact retrieval step, `sdl.file` for file/edit/window work, and `sdl.workflow` only when the work is genuinely procedural.

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
4. route one-step retrieval to `sdl.retrieve`
5. route file, edit, and source-window work to `sdl.file`
6. route execution pipelines to `sdl.workflow`

---

## Output Surfaces

Code Mode tool output is human-first. The first MCP `content` text block is concise terminal-friendly text, while task-relevant machine-readable data is carried in `structuredContent`. Agents should read the visible text for the human-facing summary and use `structuredContent` for follow-up identifiers such as `etag`, handles, file paths, symbol IDs, references, summaries, errors, and next-action hints.

SDL-MCP internal bookkeeping is not duplicated into model-visible output by default. Timing diagnostics, packed-wire stats, raw-context baselines, action traces, precondition snapshots, backup paths, and retrieval-debug details stay in logs or diagnostics surfaces. Set `includeDiagnostics: true` or the relevant retrieval-evidence option only when the task actually needs those details; even then, the normal visible text stays concise.



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

### `sdl.retrieve`

Use this when you need one exact retrieval step and do not need the planning overhead of a workflow.

Supported operations:

- `symbolSearch`
- `symbolGetCard`
- `sliceBuild`
- `codeSkeleton`
- `codeHotPath`
- `codeNeedWindow`

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

### `sdl.file`

Use this for file and edit operations inside Code Mode.

Good fits:

- read or write a non-indexed file
- preview and apply `search.edit`
- preview and apply `symbol.edit`
- request policy-gated source windows with `previewWindow` or `sourceWindow`

---

## Routing Guide

| Request shape | Start with | Why |
|:--------------|:-----------|:----|
| Explain a symbol or module | `sdl.context` | Returns task-shaped evidence without hand-building the ladder |
| Debug a bug or trace behavior | `sdl.context` | Chooses `card`, `skeleton`, `hotPath`, and raw follow-ups only when needed |
| Review code or inspect risk | `sdl.context` | Gives compact review-oriented evidence first |
| Learn a pattern before implementing | `sdl.context` | Gets structural context with less overhead than a workflow |
| Need one exact retrieval step | `sdl.retrieve` | Runs a single symbol, slice, skeleton, hot-path, or code-window operation |
| Read, write, edit, or request a source window | `sdl.file` | Keeps file operations on the compact Code Mode surface |
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
        RET["sdl.retrieve<br/>One-step retrieval"]
        FILE["sdl.file<br/>File/edit gateway"]
        WF["sdl.workflow<br/>Multi-step operations"]
    end

    Agent e1@-->|"1. What should I use?"| AS
    AS e2@-->|"ranked actions + hints"| Agent
    Agent e3@-->|"2. Show me the narrow API"| MN
    MN e4@-->|"compact manual"| Agent
    Agent e5@-->|"3a. Understand code"| CTX
    Agent e6@-->|"3b. Run one retrieval step"| RET
    Agent e7@-->|"3c. Read, edit, or request windows"| FILE
    Agent e8@-->|"3d. Execute a pipeline"| WF

    subgraph "sdl.workflow Example"
        S1["Step 0: symbolSearch"]
        S2["Step 1: runtimeExecute"]
        S3["Step 2: dataTemplate"]
        S1 e9@-->|"$0"| S2
        S2 e10@-->|"$1"| S3
    end

    WF e11@--> S1
    CTX e12@-->|"finalEvidence + metrics"| Agent
    RET e13@-->|"retrieval result"| Agent
    FILE e14@-->|"file/edit/window result"| Agent
    S3 e15@-->|"step results + budget + traces"| Agent

    style AS fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43
    style MN fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43
    style CTX fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style RET fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style FILE fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43
    style WF fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11,e12,e13,e14,e15 animate;
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
- `workflowContinuationGet`

Canonical structured continuation recipe:

```json
{
  "repoId": "[repoid]",
  "steps": [
    {
      "fn": "symbolSearch",
      "args": { "query": "WorkflowExecutor", "limit": 50 },
      "maxResponseTokens": 300
    },
    {
      "fn": "workflowContinuationGet",
      "args": {
        "handle": "$0.truncatedResponse.continuationHandle",
        "path": "results",
        "offset": 0,
        "limit": 10
      }
    },
    {
      "fn": "dataMap",
      "args": {
        "input": "$1.data",
        "fields": { "symbolId": "symbolId", "name": "name", "file": "file" }
      }
    },
    {
      "fn": "dataTemplate",
      "args": {
        "input": "$2",
        "template": "{{name}} - {{file}}",
        "joinWith": "\n"
      }
    }
  ]
}
```

When `maxResponseTokens` is too small to include any result fields, the step result includes a visible `truncated: true` marker and `truncatedResponse.continuationHandle` points to the full stored result.

The workflow engine also provides:

- budget tracking
- context-ladder validation
- internal cross-step ETag caching
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
| Enabled + gateway | Gateway tools plus `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.retrieve`, `sdl.workflow`, `sdl.file` |
| Enabled + flat | Flat tools plus `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.retrieve`, `sdl.workflow`, `sdl.file` |
| Exclusive | `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.retrieve`, `sdl.workflow`, `sdl.file` only |

---

## Recommended Agent Flow

For SDL-first agents:

1. `sdl.repo.status`
2. `sdl.action.search` when the right surface is unclear
3. `sdl.manual(query|actions)` when a compact API slice helps
4. `sdl.context` for explain/debug/review/implement context retrieval
5. `sdl.retrieve` for one exact retrieval step
6. `sdl.file` for file, edit, or source-window work
7. `sdl.workflow` for runtime execution, data shaping, batch mutations, and other procedural pipelines
8. `runtimeExecute` inside `sdl.workflow` for repo-local build, test, lint, or diagnostics

This is the intended path for enforced agent setups where SDL-MCP replaces token-heavy default tools whenever possible.

---

## Related Docs

- [Agent Context](./agent-context.md)
- [Context Modes](./context-modes.md)
- [Runtime Execution](./runtime-execution.md)
- [Tool Gateway](./tool-gateway.md)
- [Governance & Policy](./governance-policy.md)

[Back to README](../../README.md)
