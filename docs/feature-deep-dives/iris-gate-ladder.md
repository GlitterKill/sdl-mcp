# The Iris Gate Ladder: Context Without the Waste

[Back to README](../../README.md)

---

## The Problem with "Just Read the File"

When AI coding agents need to understand a function, they typically read the entire file. For a 500-line file, that consumes ~2,000 tokens, even if the answer is in a 3-line signature. Multiply that across a debugging session touching 20 files, and you've burned 40,000+ tokens on context gathering alone, most of it noise.

The Iris Gate Ladder eliminates this waste. Named after the adjustable aperture that controls light flow in optics, it lets agents dial their context window from a pinhole to wide-open, only as needed.

---

## The Four Rungs

![Iris Gate Ladder infographic](../assets/iris-gate-ladder-infographic.svg)

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    R1["Rung 1: Symbol cards<br/>~100 tokens<br/>name, signature, summary, deps, metrics"]
    R2["Rung 2: Skeleton IR<br/>~300 tokens<br/>signatures + control flow, bodies elided"]
    R3["Rung 3: Hot-path excerpt<br/>~600 tokens<br/>lines matching specific identifiers"]
    R4["Rung 4: Raw code window<br/>~2,000 tokens<br/>full source, gated by policy"]

    R1 e1@--> R2
    R2 e2@--> R3
    R3 e3@--> R4

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

### Rung 1: Symbol Cards (`sdl.symbol.getCard`)

The atom of SDL-MCP. A symbol card is a compact metadata record containing everything an agent needs to *understand* a symbol without reading its code:

- **Identity**: name, kind (function/class/interface/etc.), file, line range
- **Signature**: parameter names and types, return type, generics, overloads
- **Summary**: 1-2 line semantic description (LLM-generated or extracted)
- **Dependencies**: what it imports and calls (with confidence-scored resolution)
- **Metrics**: fan-in (who calls me), fan-out (who I call), 30-day churn, test references
- **Architecture**: cluster membership (community detection), process participation (call-chain role)
- **Versioning**: content-addressed ETag for conditional requests

**Most questions are answered here.** "What does `buildSlice` do?" "What does `handleAuth` depend on?" "Is `parseConfig` exported?" All answered by a card, for ~100 tokens.

### Rung 2: Skeleton IR (`sdl.code.getSkeleton`)

When you need to understand the *shape* of a file or class without reading every line. Skeletons include:

- All function/method signatures
- Control flow structures (`if`, `for`, `while`, `try/catch`)
- Implementation bodies replaced with `/* ... */`

Think of it as an interactive table of contents. You can also filter to `exportedOnly: true` for large library files.

### Rung 3: Hot-Path Excerpt (`sdl.code.getHotPath`)

When you know *what* you're looking for. Provide a list of identifiers (e.g., `["errorCode", "retryCount"]`) and get back only the lines where they appear, plus a configurable number of context lines above and below. Everything else is skipped.

This is surgically precise: you see exactly the code you need.

### Rung 4: Raw Code Window (`sdl.code.needWindow`)

The last resort. Full source code access, but with guardrails:

- **Justification required**: agents must explain *why* they need raw code
- **Identifier hints**: what specific identifiers they expect to find
- **Line/token limits**: enforced by the policy engine
- **Audit logging**: every raw access is recorded
- **Denial guidance**: if denied, the response suggests an alternative (e.g., "try `getHotPath` with these identifiers instead")

---

## Token Savings in Practice

| Scenario | Traditional (read file) | Iris Gate Ladder | Savings |
|:---------|:-----------------------:|:----------------:|:-------:|
| "What does `parseConfig` accept?" | ~2,000 tokens | ~100 (card) | **20x** |
| "Show me the structure of `AuthService`" | ~4,000 tokens | ~300 (skeleton) | **13x** |
| "Where is `this.cache` set?" | ~2,000 tokens | ~500 (hot-path) | **4x** |
| "Debug the retry logic in `fetchWithBackoff`" | ~2,000 tokens | ~2,000 (window) | 1x (but audited) |

**Across a typical 30-tool debugging session**, the ladder saves 10-50x tokens compared to naive file reads.

---

## Escalation Flow

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Q["Agent Question"]
    R1["Rung 1: Symbol Card<br/>~100 tokens"]
    R2["Rung 2: Skeleton IR<br/>~300 tokens"]
    R3["Rung 3: Hot-Path Excerpt<br/>~600 tokens"]
    R4["Rung 4: Raw Code Window<br/>~2,000 tokens"]
    Done["Answer Found"]

    Q e1@--> R1
    R1 e2@-->|"Answered?"| Done
    R1 e3@-->|"Need structure"| R2
    R2 e4@-->|"Answered?"| Done
    R2 e5@-->|"Need specific lines"| R3
    R3 e6@-->|"Answered?"| Done
    R3 e7@-->|"Need full code"| R4
    R4 e8@-->|"Policy gate:<br/>reason + identifiers<br/>+ line/token limits"| Done

    style R1 fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style R2 fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43
    style R3 fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43
    style R4 fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4,e5,e6,e7,e8 animate;
```

---

## Related Tools

- [`sdl.symbol.search`](../mcp-tools-detailed.md#sdlsymbolsearch) - Find symbols to get cards for
- [`sdl.slice.build`](../mcp-tools-detailed.md#sdlslicebuild) - Get cards for an entire task context at once
- [`sdl.context`](../mcp-tools-detailed.md#sdlcontext) - Let Code Mode choose the cheapest useful rung path

[Back to README](../../README.md)
