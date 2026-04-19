# Governance & Policy: Controlled Context Access

[Back to README](../../README.md)

---

## Why Gate Code Access?

Without governance, AI agents default to reading entire files. This wastes tokens, risks exposing sensitive code regions, and creates unpredictable context costs. SDL-MCP's policy engine enforces a "prove you need it" model for raw code access. Approval can proceed as soon as one or more requested identifiers match the candidate window, so tight identifier lists outperform broad catch-all requests.

---

## How It Works

Every request to `sdl.code.needWindow` (raw code, Rung 4) passes through the policy engine before code is returned:

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Req["Agent request<br/>I need to read validateToken()"]
    Policy["Policy engine<br/>identifiers required<br/>line and token caps<br/>identifier match check<br/>slice / frontier boost<br/>utility scoring"]
    Approve["APPROVE<br/>Return code + audit log"]
    Deny["DENY<br/>Return guidance + nextBestAction"]

    Req e1@--> Policy
    Policy e2@--> Approve
    Policy e3@--> Deny

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3 animate;
```

### Configurable Policy Settings

| Setting | Default | Description |
|:--------|:-------:|:------------|
| `maxWindowLines` | 180 | Maximum lines per raw code request |
| `maxWindowTokens` | 1400 | Maximum tokens per raw code request |
| `requireIdentifiers` | true | Agent must specify what identifiers it expects to find |
| `allowBreakGlass` | false | Allow emergency override with full audit logging (set to `true` to enable) |
| `defaultDenyRaw` | true | Default deny for raw code windows — requires proof-of-need (symbol in slice, identifiers provided, reason given) |
| `budgetCaps` | — | Optional server-side budget defaults: `{ maxCards, maxEstimatedTokens }` |

Adjust via `sdl.policy.set`:

```json
{
  "repoId": "my-app",
  "policyPatch": {
    "maxWindowLines": 300,
    "requireIdentifiers": true
  }
}
```

### What Gets Audited

Every raw code access and every denial is logged with:

- **Audit hash** — unique identifier for the decision
- **Request details** — who asked, for what symbol, with what justification
- **Decision** — approve, deny, or downgrade (to skeleton/hot-path)
- **Evidence used** — what factors influenced the decision

### Graceful Denials

When a request is denied, the response doesn't just say "no." It provides:

```json
{
  "approved": false,
  "whyDenied": ["No identifiers matched in the requested range"],
  "nextBestAction": {
    "tool": "sdl.code.getHotPath",
    "args": {
      "symbolId": "abc123",
      "identifiersToFind": ["errorCode", "retryCount"]
    },
    "rationale": "Hot-path can locate these identifiers without full code access"
  }
}
```

---

## Policy Decision Tree

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart TD
    Req["sdl.code.needWindow request"]
    C1{"Identifiers<br/>provided?"}
    C2{"Within line<br/>limit?"}
    C3{"Within token<br/>limit?"}
    C4{"Identifiers<br/>exist in range?"}
    C5{"Symbol in<br/>current slice?"}
    C6{"Scorer utility<br/>above threshold?"}
    C7{"Break-glass<br/>allowed?"}
    Approve["APPROVE<br/>Return code + audit log"]
    Deny["DENY<br/>Return guidance +<br/>nextBestAction"]

    Req e1@--> C1
    C1 e2@-->|No| Deny
    C1 e3@-->|Yes| C2
    C2 e4@-->|Exceeds maxWindowLines| Deny
    C2 e5@-->|OK| C3
    C3 e6@-->|Exceeds maxWindowTokens| Deny
    C3 e7@-->|OK| C4
    C4 e8@-->|Found| Approve
    C4 e9@-->|Not found| C5
    C5 e10@-->|In slice/frontier| Approve
    C5 e11@-->|Not in slice| C6
    C6 e12@-->|Above threshold| Approve
    C6 e13@-->|Below threshold| C7
    C7 e14@-->|Enabled + audit| Approve
    C7 e15@-->|Disabled| Deny

    style Approve fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43
    style Deny fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43

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

## Runtime Execution Governance

`sdl.runtime.execute` has its own governance layer:

- **Enabled by default** - set `runtime.enabled: false` in hardened deployments that cannot permit subprocess execution
- **Executable validation** — only allowed executables can run
- **CWD jailing** — subprocess can't escape the repo root
- **Environment scrubbing** — only `PATH` and allowlisted vars are passed
- **Concurrency limits** — prevents resource exhaustion
- **Timeout enforcement** — hard kill on timeout
- **Output truncation** — responses are summarized, not raw-dumped

---

## Related Tools

- [`sdl.policy.get`](../mcp-tools-detailed.md#sdlpolicyget) - Read current policy
- [`sdl.policy.set`](../mcp-tools-detailed.md#sdlpolicyset) - Update policy settings
- [`sdl.code.needWindow`](../mcp-tools-detailed.md#sdlcodeneedwindow) - The gated raw code tool
- [`sdl.runtime.execute`](../mcp-tools-detailed.md#sdlruntimeexecute) - Sandboxed command execution

[Back to README](../../README.md)
