# Governance & Policy: Controlled Context Access

[Back to README](../../README.md)

---

## Why Gate Code Access?

Without governance, AI agents default to reading entire files. This wastes tokens, risks exposing sensitive code regions, and creates unpredictable context costs. SDL-MCP's policy engine enforces a "prove you need it" model for raw code access.

---

## How It Works

Every request to `sdl.code.needWindow` (raw code, Rung 4) passes through the policy engine before code is returned:

```
  Agent Request
  "I need to read validateToken()"
       │
       ▼
  ┌──────────────────────────────┐
  │       Policy Engine          │
  │                              │
  │  ✓ Identifiers provided?     │──── deny if empty
  │  ✓ Within line limit?        │──── deny if > maxWindowLines
  │  ✓ Within token limit?       │──── deny if > maxWindowTokens
  │  ✓ Identifiers exist?        │──── deny if not in range
  │  ✓ Symbol in current slice?  │──── more likely to approve
  │  ✓ Scorer utility check      │──── is the code worth reading?
  │                              │
  └──────────┬───────────────────┘
             │
      ┌──────┴──────┐
      │             │
   APPROVE       DENY
      │             │
      ▼             ▼
  Return code   Return guidance
  + audit log   + nextBestAction
                "Try getHotPath
                 with ['errorCode']"
```

### Configurable Policy Settings

| Setting | Default | Description |
|:--------|:-------:|:------------|
| `maxWindowLines` | 180 | Maximum lines per raw code request |
| `maxWindowTokens` | 1400 | Maximum tokens per raw code request |
| `requireIdentifiers` | true | Agent must specify what identifiers it expects to find |
| `allowBreakGlass` | true | Allow emergency override with full audit logging |

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

## Runtime Execution Governance

`sdl.runtime.execute` has its own governance layer:

- **Disabled by default** — must be explicitly enabled in config
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
