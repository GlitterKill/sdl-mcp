# Agent Orchestration & Intelligence

[Back to README](../../README.md)

---

## Autopilot Mode

`sdl.agent.orchestrate` is SDL-MCP's autonomous task execution engine. Instead of manually climbing the Iris Gate Ladder tool by tool, the orchestrator plans the optimal path, executes it, collects evidence, and returns a synthesized answer.

```
  Task: "Why does fetchUser throw on expired tokens?"
       │
       ▼
  ┌──────────────────────────────────┐
  │         Task Planner             │
  │                                  │
  │  Task type: debug                │
  │  Budget: 5000 tokens, 10 actions │
  │  Focus: fetchUser, tokenValidator│
  │                                  │
  │  Planned path:                   │
  │  card → card → skeleton → hotPath│
  │                                  │
  │  Estimated cost: 950 tokens      │
  └──────────┬───────────────────────┘
             │
    Execute each rung
             │
  ┌──────────┼──────────┐
  │          │          │
  ▼          ▼          ▼
card(1)   card(2)   skeleton   hotPath
 50 tok    50 tok    200 tok    500 tok
  │          │          │         │
  └──────────┴──────────┴─────────┘
                  │
                  ▼
  ┌──────────────────────────────────┐
  │         Evidence Collector       │
  │                                  │
  │  • fetchUser calls validateToken │
  │  • validateToken checks exp claim│
  │  • Throws TokenExpiredError      │
  │  • No retry logic present        │
  │                                  │
  │  Answer: "fetchUser throws       │
  │  because validateToken checks    │
  │  the `exp` claim and throws      │
  │  TokenExpiredError with no       │
  │  retry/refresh fallback."        │
  └──────────────────────────────────┘
```

### Task Types

| Type | Rung Strategy | Use Case |
|:-----|:-------------|:---------|
| `debug` | card → skeleton → hotPath → raw | Tracing bugs through call chains |
| `review` | card → skeleton | Understanding changes for code review |
| `implement` | card → skeleton → hotPath | Learning patterns before writing new code |
| `explain` | card → skeleton | Generating explanations for documentation |

### Budget Controls

The planner estimates token costs per rung and trims from the end when budget-constrained:

| Rung | Estimated Tokens |
|:-----|:----------------:|
| Card | ~50 |
| Skeleton | ~200 |
| Hot-Path | ~500 |
| Raw | ~2,000 |

If your budget is 800 tokens, the planner might select `card → card → skeleton` and skip hot-path and raw entirely.

---

## Feedback Loop

After using a slice, agents can report which symbols were useful and which were missing via `sdl.agent.feedback`. This data is stored and aggregated to improve future slice relevance.

```
  After task completion:
  ┌─────────────────────────────┐
  │  sdl.agent.feedback         │
  │                             │
  │  useful: [sym1, sym2, sym5] │  ← these were helpful
  │  missing: [sym8]            │  ← expected but not in slice
  └─────────────┬───────────────┘
                │
                ▼
  ┌─────────────────────────────┐
  │  Aggregated Statistics      │
  │                             │
  │  topUseful:                 │
  │    validateToken (12 uses)  │
  │    dbQuery (9 uses)         │
  │                             │
  │  topMissing:                │
  │    errorHandler (5 reports) │  ← should be prioritized
  │    retryLogic (3 reports)   │     in future slices
  └─────────────────────────────┘
```

Query aggregated feedback via `sdl.agent.feedback.query` to understand which symbols are consistently valuable and which are consistently missing from slices.

---

## Context Summary (Portable Briefings)

`sdl.context.summary` generates a structured, token-bounded context package that can be copy/pasted into non-MCP environments (Slack, Jira, PR descriptions, etc.):

```markdown
## Context: "auth middleware"

### Key Symbols
- `authenticate(req, res, next)` — Validates JWT token and attaches user to request
  - Cluster: auth-module (8 members)
  - Process: request-pipeline (entry, depth 0)
- `validateToken(token: string)` — Checks token signature and expiration
  - Process: request-pipeline (intermediate, depth 1)

### Dependencies
authenticate → validateToken → JwtConfig

### Risk Areas
- validateToken (fan-in: 12, high churn)

### Files Touched
- src/auth/middleware.ts (3 symbols)
- src/auth/jwt.ts (2 symbols)
```

Available in markdown, JSON, or clipboard-optimized formats.

---

## Predictive Prefetch

SDL-MCP anticipates your next tool call. When you search for symbols, the top 5 results have their cards prefetched. When you get a card, its slice frontier is prefetched. This reduces perceived latency for common workflows.

`sdl.repo.status` reports prefetch metrics:

```json
{
  "prefetchStats": {
    "hitRate": 0.72,
    "wasteRate": 0.15,
    "avgLatencyReductionMs": 45
  }
}
```

---

## Related Tools

- [`sdl.agent.orchestrate`](../mcp-tools-detailed.md#sdlagentorchestrate) - Autonomous task execution
- [`sdl.agent.feedback`](../mcp-tools-detailed.md#sdlagentfeedback) - Record feedback
- [`sdl.agent.feedback.query`](../mcp-tools-detailed.md#sdlagentfeedbackquery) - Query aggregated feedback
- [`sdl.context.summary`](../mcp-tools-detailed.md#sdlcontextsummary) - Portable context briefings

[Back to README](../../README.md)
