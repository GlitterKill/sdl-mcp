# Live Indexing: Real-Time Code Intelligence

[Back to README](../../README.md)

---

## The Stale Context Problem

Traditional code indexing is a batch operation: you index once, then the database is stale until you index again. For an AI agent helping you write code, this means the symbols it sees are always one step behind your edits.

SDL-MCP's live indexing system eliminates this gap. As you type in your editor, SDL-MCP receives buffer updates, parses them in the background, and overlays the new symbols on top of the durable database. Search, cards, and slices reflect your *current* code, not your last save.

---

## Architecture

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Editor["Editor (VSCode, etc.)"] e1@-->|"open / change / save / close"| Push["sdl.buffer.push<br/>full buffer content + metadata"]
    Push e2@--> Overlay["Overlay Store<br/>dirty buffers, parse queue, symbol cache"]
    Overlay e3@--> Tools["MCP Tool Layer<br/>search, card, slice, skeleton"]
    Overlay e4@-->|"save / checkpoint"| DB["LadybugDB<br/>(durable)"]
    DB e5@--> Tools

    style Overlay fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43
    style DB fill:#d4edda,stroke:#2b8a3e

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5 animate;
```

### Overlay Merge and Checkpoint Flow

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Editor["Editor (VSCode, etc.)"]
    Push["sdl.buffer.push<br/>(full buffer content)"]
    Overlay["Overlay Store (in-memory)"]
    Parse["Background AST Parse<br/>(tree-sitter)"]
    Cache["Draft Symbol Cache"]

    subgraph "MCP Tool Query"
        Query["search / card / slice / skeleton"]
        Merge["Merge overlay symbols<br/>on top of durable DB"]
        Result["Return combined results<br/>(draft shadows durable)"]
    end

    Save["File Save / sdl.buffer.checkpoint"]
    DB["LadybugDB (durable)"]
    Reconcile["Background Reconciler<br/>(cleanup stale drafts)"]

    Editor e1@-->|"buffer events"| Push
    Push e2@--> Overlay
    Overlay e3@--> Parse
    Parse e4@--> Cache
    Cache e5@--> Merge
    Query e6@--> Merge
    Merge e7@--> Result
    Save e8@--> DB
    DB e9@--> Reconcile
    Reconcile e10@--> Overlay

    style Editor fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43
    style DB fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style Overlay fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10 animate;
```

### How It Works

1. **Buffer Push**: Your editor extension sends the full file content on every keystroke (debounced) via `sdl.buffer.push`.
2. **Background Parse**: The overlay store queues a tree-sitter parse to extract symbols from the draft content.
3. **Overlay Merge**: When any tool queries the database (search, getCard, slice.build), the overlay symbols are merged on top of the durable DB results. Draft symbols shadow their durable counterparts.
4. **Checkpoint**: On file save or manual checkpoint (`sdl.buffer.checkpoint`), the overlay is written to the durable LadybugDB graph.
5. **Reconciliation**: A background reconciler ensures overlay and durable state converge, cleaning up stale drafts.

### What Gets Overlaid

| Tool | Overlay Behavior |
|:-----|:-----------------|
| `sdl.symbol.search` | Draft symbols appear in results alongside durable symbols |
| `sdl.symbol.getCard` | Returns draft symbol card if the file has unsaved changes |
| `sdl.slice.build` | Includes draft symbols in the BFS traversal |
| `sdl.code.getSkeleton` | Generates skeleton from draft content |
| `sdl.code.getHotPath` | Searches draft content for identifiers |

---

## Configuration

```jsonc
{
  "liveIndex": {
    "enabled": true,          // master switch
    "debounceMs": 75,         // debounce between buffer events (25-5000, default: 75)
    "idleCheckpointMs": 15000,// auto-checkpoint after idle period (default: 15s)
    "maxDraftFiles": 200,     // max concurrent draft files (default: 200)
    "reconcileConcurrency": 1,// concurrent overlay→DB merge jobs (1-8)
    "clusterRefreshThreshold": 25 // reconciled symbols before cluster refresh
  }
}
```

### Status Monitoring

`sdl.repo.status` includes a `liveIndexStatus` section:

```json
{
  "liveIndexStatus": {
    "enabled": true,
    "pendingBuffers": 2,
    "dirtyBuffers": 1,
    "parseQueueDepth": 0,
    "checkpointPending": false,
    "lastCheckpointResult": "success"
  }
}
```

For deeper diagnostics, use `sdl.buffer.status`.

---

## Related Tools

- [`sdl.buffer.push`](../mcp-tools-detailed.md#sdlbufferpush) - Push editor buffer events
- [`sdl.buffer.checkpoint`](../mcp-tools-detailed.md#sdlbuffercheckpoint) - Force a checkpoint
- [`sdl.buffer.status`](../mcp-tools-detailed.md#sdlbufferstatus) - Live indexing diagnostics
- [`sdl.repo.status`](../mcp-tools-detailed.md#sdlrepostatus) - Includes live index health

[Back to README](../../README.md)
