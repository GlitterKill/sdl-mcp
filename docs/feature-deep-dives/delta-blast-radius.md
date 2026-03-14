# Delta Packs & Blast Radius: Know What Changed and What It Broke

[Back to README](../../README.md)

---

## Beyond Line Diffs

`git diff` tells you *what lines changed*. SDL-MCP tells you *what that change means* at the symbol level and *who might be affected*.

A delta pack contains:

- **Changed symbols** with semantic diffs (signature changes, invariant additions/removals, side-effect changes)
- **Blast radius** — ranked list of dependent symbols that may be impacted
- **Fan-in trends** — which symbols are becoming increasingly depended upon (amplifiers)
- **Risk tiers** — whether the interface, behavior, and side effects are stable

---

## Anatomy of a Delta Pack

```
         Code Change: modified `validateToken()` signature
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       signatureDiff    invariantDiff    sideEffectDiff
       ┌────────────┐  ┌─────────────┐  ┌──────────────┐
       │before:     │  │added:       │  │added:        │
       │ (token:    │  │ "throws on  │  │ "logs to     │
       │  string)   │  │  expired"   │  │  audit trail"│
       │after:      │  │removed:     │  │              │
       │ (token:    │  │ (none)      │  │              │
       │  string,   │  └─────────────┘  └──────────────┘
       │  options?: │
       │  object)   │
       └────────────┘
              │
              ▼
      ┌──── Blast Radius ────┐
      │                      │
      │  1. authenticate()   │ ← distance: 1, direct caller
      │  2. refreshSession() │ ← distance: 1, direct caller
      │  3. AuthMiddleware    │ ← distance: 2, calls authenticate
      │  4. loginHandler()   │ ← distance: 2, calls authenticate
      │  5. auth.test.ts     │ ← test file, flagged for re-run
      │                      │
      └──────────────────────┘
```

### Blast Radius Ranking

Each affected symbol is ranked by multiple signals:

| Signal | What It Measures |
|:-------|:-----------------|
| **Distance** | Hops in the dependency graph from the changed symbol |
| **Fan-in** | How many other symbols depend on the affected symbol |
| **Test proximity** | Whether the affected symbol has tests that should be re-run |
| **Process participation** | Whether the symbol is part of a critical call chain |

### Fan-In Trend Analysis (Amplifiers)

SDL-MCP tracks how a symbol's fan-in changes across versions. A symbol whose fan-in is growing rapidly is an **amplifier** — changes to it ripple through an increasing number of dependents. The delta response flags these:

```json
{
  "amplifiers": [
    {
      "symbolId": "abc123",
      "previous": 5,
      "current": 12,
      "growthRate": 1.4
    }
  ]
}
```

---

## PR Risk Analysis

`sdl.pr.risk.analyze` wraps delta analysis with structured risk scoring:

- **Risk score** (0-100) computed from the number of changes, blast radius size, and risk tier stability
- **Findings** categorized by severity (high/medium/low)
- **Evidence** supporting each finding
- **Recommended tests** prioritized by risk, targeting the most impacted symbols

```
  Risk Score: 72 (HIGH)

  Findings:
  ├── [HIGH] Signature change on validateToken (fan-in: 12)
  ├── [MED]  New side effect: audit trail logging
  └── [LOW]  Invariant addition (non-breaking)

  Recommended Tests:
  ├── [HIGH] Re-run auth.test.ts (direct coverage)
  ├── [HIGH] Re-run middleware.test.ts (blast radius)
  └── [MED]  Add test for new options parameter
```

---

## Related Tools

- [`sdl.delta.get`](../mcp-tools-detailed.md#sdldeltaget) - Raw delta pack retrieval
- [`sdl.pr.risk.analyze`](../mcp-tools-detailed.md#sdlprriskanalyze) - Structured risk analysis
- [`sdl.slice.refresh`](../mcp-tools-detailed.md#sdlslicerefresh) - Delta-scoped slice updates

[Back to README](../../README.md)
