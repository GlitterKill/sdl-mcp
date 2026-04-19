# Tool Gateway

[Back to README](../../README.md) | [Documentation Hub](../README.md) | [Generated Tool Inventory](../generated/tool-inventory.md)

The gateway compresses most of the flat SDL-MCP surface into four namespace tools: `sdl.query`, `sdl.code`, `sdl.repo`, and `sdl.agent`. It exists to reduce `tools/list` overhead without changing the underlying handler behavior.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    Flat["Flat mode<br/>33 tools<br/>2 universal + 31 flat"]
    Shrink["Gateway projection<br/>30 gateway-routable actions"]
    Gateway["Gateway mode<br/>6 tools<br/>2 universal + 4 gateway"]

    Flat e1@--> Shrink
    Shrink e2@--> Gateway

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2 animate;
```

## Current Surface Matrix

| Mode | Tool count | Composition |
| --- | --- | --- |
| Flat | `33` | `2` universal + `31` flat tools |
| Gateway | `6` | `2` universal + `4` gateway tools |
| Gateway + legacy | `37` | `2` universal + `4` gateway + `31` flat tools |
| Code Mode exclusive | `4` | `sdl.action.search`, `sdl.context`, `sdl.manual`, `sdl.workflow` |

The generated source of truth is [tool-inventory.md](../generated/tool-inventory.md).

## What the Gateway Actually Covers

The gateway currently exposes `30` of the `31` flat actions. The missing flat action is `sdl.file.write`, which remains flat-only today.

| Gateway tool | Actions | Current action set |
| --- | --- | --- |
| `sdl.query` | `7` | `symbol.search`, `symbol.getCard`, `slice.build`, `slice.refresh`, `slice.spillover.get`, `delta.get`, `pr.risk.analyze` |
| `sdl.code` | `3` | `code.needWindow`, `code.getSkeleton`, `code.getHotPath` |
| `sdl.repo` | `9` | `repo.register`, `repo.status`, `repo.overview`, `index.refresh`, `policy.get`, `policy.set`, `usage.stats`, `file.read`, `scip.ingest` |
| `sdl.agent` | `11` | `agent.feedback`, `agent.feedback.query`, `buffer.push`, `buffer.checkpoint`, `buffer.status`, `runtime.execute`, `runtime.queryOutput`, `memory.store`, `memory.query`, `memory.remove`, `memory.surface` |

## Routing Path

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    Agent["Agent call"] e1@--> Gateway{"Namespace tool"}
    Gateway e2@--> Q["sdl.query"]
    Gateway e3@--> C["sdl.code"]
    Gateway e4@--> R["sdl.repo"]
    Gateway e5@--> A["sdl.agent"]

    Q e6@--> Normalize["Normalize aliases<br/>camelCase + snake_case"]
    C e7@--> Normalize
    R e8@--> Normalize
    A e9@--> Normalize
    Normalize e10@--> Strict["Strict per-action schema"]
    Strict e11@--> Handler["Same handler layer<br/>used by flat tools"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11 animate;
```

The important implementation detail is not the namespace wrapper. It is the preservation of the original validation and handler path after routing. Gateway mode is a registration optimization, not a separate execution engine.

## Why It Exists

- Fewer tool descriptors reduce startup token cost in MCP clients.
- Namespace routing keeps tool choice simpler for agents that do not need every flat tool listed separately.
- The underlying handlers stay shared, so behavior drift between flat and gateway mode stays low.

## Limits and Gotchas

- `sdl.file.write` is still flat-only.
- `sdl.info` is universal outside Code Mode exclusive. It is not part of the four gateway tools.
- Code Mode exclusive bypasses the regular gateway and flat surfaces entirely.
- The CLI `sdl-mcp tool` command is related but not identical. It exposes a narrower direct-action subset. See [CLI Tool Access](./cli-tool-access.md).

## Configuration

The current non-deprecated gateway setting is:

```json
{
  "gateway": {
    "enabled": true
  }
}
```

That setting only matters when Code Mode is not exclusive. With the default `codeMode.exclusive: true`, the server exposes the Code Mode-only surface instead.

If you are migrating older agent instructions that still depend on flat tool names, there is still a compatibility path in source for emitting legacy flat aliases alongside gateway tools. It is intentionally omitted from the main configuration reference because it is deprecated and should not be the recommended steady-state setup.

## When To Use Which Surface

| Situation | Recommended surface |
| --- | --- |
| Smallest registration footprint | Gateway mode |
| Task-shaped retrieval first | Code Mode |
| Need `file.write` | Flat mode or flat + Code Mode |
| Existing legacy instructions still call flat tools | Flat mode, or a temporary migration setup |

## Practical Recommendation

If you want the current best default for agent work, use Code Mode for discovery and retrieval, then disable exclusivity only when you also need the regular gateway or flat tools in the same session.
