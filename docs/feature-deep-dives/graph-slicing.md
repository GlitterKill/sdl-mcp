# Graph Slicing: The Right Context for Every Task

[Back to README](../../README.md)

---

## Why Directories Are the Wrong Abstraction

Traditional code assistants answer "what context do I need?" by reading files in the same directory. But code doesn't respect directory boundaries. A function in `src/auth/validate.ts` might depend on `src/db/queries.ts`, `src/config/types.ts`, and `src/util/hashing.ts`. Directory-based context misses these cross-cutting relationships.

SDL-MCP's graph slicing follows the *dependency graph* instead. Starting from the symbols relevant to your task, it traverses call and import edges outward, scoring each symbol by relevance, and returns the N most important symbols within a token budget.

---

## How Slicing Works

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Task["Task: Fix the auth middleware"]
    Seeds["Entry symbols<br/>authenticate<br/>validateToken"]
    Search["Weighted BFS / beam search"]
    Calls["Direct call edges<br/>hashPw<br/>getUserById<br/>JwtConfig"]
    Frontier["Frontier just outside slice<br/>bcrypt<br/>dbQuery<br/>envLoader"]
    Slice["Budgeted slice output<br/>8 cards returned (~800 tokens)<br/>instead of ~16k tokens of file reads"]

    Task e1@--> Seeds
    Seeds e2@--> Search
    Search e3@--> Calls
    Calls e4@--> Slice
    Search e5@--> Frontier

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5 animate;
```

### Edge Weights

Not all relationships are equal. SDL-MCP weights edges by how strongly they indicate relevance:

| Edge Type | Weight | Rationale |
|:----------|:------:|:----------|
| **Call** | 1.0 | If A calls B, B is almost certainly relevant to understanding A |
| **Implements** | 0.9 | Interface and trait implementation edges are highly relevant in polymorphic code |
| **Config** | 0.8 | Configuration dependencies are important but less direct |
| **Import** | 0.6 | An import indicates awareness, not necessarily relevance |

### Scoring Factors

Each symbol in the BFS frontier is scored by weighted factors:

- **Query relevance** (weight: 0.4) — search term overlap from `taskText`
- **Stack trace locality** (weight: 0.2) — proximity to parsed stack trace entries
- **Hotness** (weight: 0.15) — composite of fan-in, fan-out, and churn metrics
- **Structure** (weight: 0.15) — file path structural specificity
- **Kind** (weight: 0.1) — symbol kind weight (functions/methods scored higher than variables)
- **Cluster cohesion** — same-cluster symbols get a +0.15 boost, related-cluster +0.05
- **Confidence** of the edge resolution (low-confidence call edges can be filtered via `minConfidence` or `minCallConfidence`)

---

## Slice Lifecycle

Slices aren't one-shot. They have a full lifecycle:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    Build["slice.build"] e1@--> Handle["handle"]
    Handle e5@--> Refresh["slice.refresh"]
    Refresh e6@--> Delta["delta"]
    Delta e7@--> Spillover["slice.spillover.get"]
    Spillover e8@--> Overflow["overflow pages"]
    Handle e2@--> Rebuild["lease expires -> rebuild"]
    Delta e3@--> NotModified["nothing changed -> notModified"]
    Overflow e4@--> Done["no more pages -> done"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8 animate;
```
1. **Build** (`sdl.slice.build`) — Creates the slice, returns a handle and lease
2. **Refresh** (`sdl.slice.refresh`) — Returns only what changed since your last version (dramatically cheaper than rebuilding)
3. **Spillover** (`sdl.slice.spillover.get`) — Pages through symbols that didn't fit in the budget

### Lifecycle Diagram

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    Start(("start"))
    Build["sdl.slice.build"]
    Handle["handle + lease"]
    Refresh["sdl.slice.refresh"]
    Delta["changed cards"]
    NotModified["notModified"]
    Spillover["sdl.slice.spillover.get"]
    Page{"more pages?"}
    Done(("done"))
    Expired{"lease expired?"}

    Start e1@--> Build
    Build e2@--> Handle
    Handle e3@--> Refresh
    Refresh e4@--> Delta
    Refresh e5@--> NotModified
    Delta e6@--> Handle
    NotModified e7@--> Handle
    Handle e8@--> Spillover
    Spillover e9@--> Page
    Page e10@-->|yes| Spillover
    Page e11@-->|no| Done
    Handle e12@--> Expired
    Expired e13@-->|yes| Build

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class Start,Done source;
    class Build,Refresh,Spillover process;
    class Handle,Delta,NotModified storage;
    class Page,Expired decision;
    class e1,e2,e3,e4,e5,e6,e7,e8,e9,e10,e11,e12,e13 animate;
```

### Auto-Discovery Mode

You don't even need to know symbol IDs. Pass a `taskText` string (or `stackTrace`, `failingTestPath`, `editedFiles`) and SDL-MCP will automatically discover the best entry symbols:

**With hybrid retrieval** (when `semantic.retrieval.mode: "hybrid"` and indexes are healthy):
1. Run a single hybrid search (FTS + vector + RRF fusion) on the task text
2. Score and rank candidates across all retrieval sources
3. Build the slice from the top-ranked seeds

**Legacy fallback** (when hybrid is unavailable):
1. Token-by-token `searchSymbolsLite` fan-out across the task text
2. Score and rank individual matches
3. Build the slice from the top-ranked seeds

The hybrid path produces better start-node quality because it understands *meaning* (via vector search) not just token overlap, and it runs a single efficient query instead of per-token fan-out.

```json
{
  "repoId": "my-app",
  "taskText": "fix the authentication timeout bug",
  "budget": { "maxCards": 30, "maxEstimatedTokens": 4000 },
  "includeRetrievalEvidence": true
}
```

When `includeRetrievalEvidence: true` is set, the slice response includes evidence showing how seeds were discovered:

```json
{
  "retrievalEvidence": {
    "mode": "hybrid",
    "symptomType": "taskText",
    "candidateCountPerSource": {
      "fts": 28,
      "vector:jina-embeddings-v2-base-code": 24
    },
    "fusionLatencyMs": 8,
    "fallbackReason": null
  }
}
```

The `symptomType` field classifies the input: `"taskText"`, `"stackTrace"`, `"failingTest"`, or `"editedFiles"`.

---

## Wire Format Efficiency

Slices support three compact wire format versions for minimal bandwidth:

| Version | Encoding | Best For |
|:-------:|:---------|:---------|
| V1 | Shortened field names | Backward compatibility |
| V2 (default) | + deduplicated file paths & edge type lookup tables | Most use cases |
| V3 | + grouped edge encoding | Large, edge-dense graphs |

Combined with ETag-based conditional cards (`knownCardEtags`), a slice refresh can return zero duplicate data.

---

## Related Tools

- [`sdl.symbol.search`](../mcp-tools-detailed.md#sdlsymbolsearch) - Find entry symbols
- [`sdl.context`](../mcp-tools-detailed.md#sdlcontext) - Let Code Mode assemble task-shaped slice evidence
- [`sdl.delta.get`](../mcp-tools-detailed.md#sdldeltaget) - Change tracking between versions

[Back to README](../../README.md)
