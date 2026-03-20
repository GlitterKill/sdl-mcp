# Tool Gateway

**Reduce MCP tool registration overhead by 81% — from 30 individual tools down to 4 namespace-scoped gateway tools.**

The tool gateway consolidates all 30 SDL-MCP tools into 4 typed proxy tools (`sdl.query`, `sdl.code`, `sdl.repo`, `sdl.agent`). Each gateway tool accepts an `action` discriminator field to route calls to the appropriate handler. This dramatically reduces the token cost of `tools/list` responses that agents must process at the start of every conversation.

---

## The Problem

When an MCP client connects, it calls `tools/list` to discover available tools. The response includes tool names, descriptions, and JSON schemas. For 30 tools with detailed Zod-derived schemas, this can consume **~3,742+ tokens** — tokens that come out of the agent's finite context window before any real work begins.

```
Without gateway:
  tools/list → 30 tools × (name + description + schema)
  = ~4,000+ tokens consumed at conversation start

With gateway:
  tools/list → 4 tools × (name + compact description + thin schema)
  = ~713 tokens consumed at conversation start

Savings: ~3,029 tokens per conversation (81% reduction)
```

This matters because:
- Agents process `tools/list` at the **start of every conversation**
- Tokens spent on tool schemas are tokens **not available** for code context
- Large tool registrations cause some MCP clients to **truncate or error**
- Fewer tools means fewer **selection decisions** for the agent (faster + more accurate)

---

## Architecture

### Before (Flat Mode)

```
┌─────────────────────────────────────────────────────┐
│                    MCP Server                        │
│                                                      │
│  sdl.repo.register    sdl.symbol.search              │
│  sdl.repo.status      sdl.symbol.getCard             │
│  sdl.repo.overview    sdl.symbol.getCards             │
│  sdl.index.refresh    sdl.slice.build                │
│  sdl.buffer.push      sdl.slice.refresh              │
│  sdl.buffer.checkpoint sdl.slice.spillover.get       │
│  sdl.buffer.status    sdl.delta.get                  │
│  sdl.code.needWindow  sdl.policy.get                 │
│  sdl.code.getSkeleton sdl.policy.set                 │
│  sdl.code.getHotPath  sdl.pr.risk.analyze            │
│  sdl.agent.orchestrate sdl.context.summary           │
│  sdl.agent.feedback   sdl.agent.feedback.query       │
│  sdl.runtime.execute  sdl.memory.store               │
│  sdl.memory.query     sdl.memory.remove              │
│  sdl.memory.surface  sdl.manual                      │
│                                                      │
│            30 tools × full JSON schema               │
│               ~4,000+ tokens total                   │
└─────────────────────────────────────────────────────┘
```

### After (Gateway Mode)

```
┌─────────────────────────────────────────────────────┐
│                    MCP Server                        │
│                                                      │
│  sdl.query   → 9 actions (symbol.*, slice.*, etc.)    │
│  sdl.code    → 3 actions (code.*)                     │
│  sdl.repo    → 6 actions (repo.*, index.*, policy.*)  │
│  sdl.agent   → 11 actions (agent.*, buffer.*, runtime,│
│                             memory.*)                  │
│                                                      │
│        4 tools × thin schema + compact desc          │
│               ~713 tokens total                      │
└─────────────────────────────────────────────────────┘
```

---

## How It Works

### Gateway Routing Diagram

```mermaid
flowchart LR
    Agent["Agent Call"]

    subgraph "Gateway Layer"
        GW{"Which gateway<br/>tool?"}
        Q["sdl.query<br/>(9 actions)"]
        C["sdl.code<br/>(3 actions)"]
        R["sdl.repo<br/>(6 actions)"]
        A["sdl.agent<br/>(12 actions)"]
    end

    subgraph "Validation"
        Thin["Thin Schema<br/>(first pass)"]
        Router["Router: extract action<br/>+ merge repoId"]
        Strict["Original Zod Schema<br/>(strict second pass)"]
    end

    Handler["Same Handler<br/>as Flat Mode"]

    Agent --> GW
    GW --> Q & C & R & A
    Q & C & R & A --> Thin
    Thin --> Router
    Router --> Strict
    Strict --> Handler

    style Agent fill:#cce5ff,stroke:#004085
    style Handler fill:#d4edda,stroke:#28a745
```

### 1. Namespace-Scoped Tools

The 30 tools are organized into 4 namespaces:

| Gateway Tool | Actions | Domain |
|:-------------|:--------|:-------|
| `sdl.query` | 9 | Read-only intelligence: symbol search/cards, slices, deltas, summaries, PR risk |
| `sdl.code` | 3 | Gated code access: needWindow, skeleton, hotPath |
| `sdl.repo` | 6 | Repository lifecycle: register, status, overview, index, policy |
| `sdl.agent` | 11 | Agentic ops: orchestrate, feedback, buffers, runtime, memory |

### 2. Discriminated Union Schema

Each gateway tool uses a Zod discriminated union on the `action` field. The calling pattern is:

```json
// Instead of:
{ "tool": "sdl.symbol.search", "args": { "repoId": "x", "query": "auth" } }

// Gateway mode:
{ "tool": "sdl.query", "args": { "repoId": "x", "action": "symbol.search", "query": "auth" } }
```

The `repoId` field is hoisted to the envelope level (shared across all actions in a namespace), and the `action` field discriminates which handler processes the call.

### 3. Double Validation

Validation happens in two passes for safety:

```
Agent Call
    │
    ▼
┌─────────────────────┐
│ Gateway Schema       │  Discriminated union on `action`
│ (cheap first-pass)   │  Catches wrong action names, type errors
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Router               │  Extracts action, merges repoId
│                      │  Looks up handler from ActionMap
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Original Zod Schema  │  Strict second-pass validation
│ (per-handler)        │  Identical to flat-mode validation
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Handler Function     │  Same handler as flat mode
│                      │  Zero behavioral difference
└─────────────────────┘
```

### 4. Thin Wire Schemas

The key to token savings is the **thin schema** emitted in `tools/list` responses. Instead of the full Zod-derived JSON Schema (which includes every field, constraint, and nested object), the thin schema is a minimal envelope:

```json
{
  "type": "object",
  "properties": {
    "repoId": { "type": "string", "minLength": 1 },
    "action": { "type": "string", "enum": ["symbol.search", "symbol.getCard", "..."] }
  },
  "required": ["action", "repoId"],
  "additionalProperties": true
}
```

The `additionalProperties: true` flag lets action-specific parameters pass through. The tool description contains a compact reference card listing all actions and their parameters, which gives the agent enough information to construct correct calls.

Full validation still happens server-side via the strict Zod schemas — the thin wire schema is purely for the `tools/list` response to minimize token cost.

---

## Token Savings Breakdown

Measured with the included token measurement script (`scripts/measure-gateway-schema-tokens.ts`):

| Mode | Tools | Characters | Est. Tokens |
|:-----|:-----:|:----------:|:-----------:|
| **Flat** (30 individual tools) | 30 | ~17,000 | ~4,250 |
| **Gateway** (4 namespace tools) | 4 | ~2,900 | ~725 |
| **Hybrid** (4 gateway + 30 legacy) | 34 | — | — |

| Metric | Value |
|:-------|:------|
| **Token reduction** | **~83%** (4,250 → 725) |
| **Tokens saved per conversation** | **~3,525** |
| **Character reduction** | ~17,000 → ~2,900 |
| **Tool count reduction** | 30 → 4 |

The savings come from three techniques:
1. **Fewer tools** — 4 vs 30 registration entries
2. **Thin schemas** — minimal envelope vs full Zod-derived JSON Schema
3. **Description stripping** — descriptions stripped from schema nodes (action info is in the tool-level description instead)
4. **$defs deduplication** — repeated sub-schemas hoisted to `$defs` with `$ref` pointers (via `compact-schema.ts`)

---

## Configuration

Gateway mode is controlled in your SDL-MCP config file:

```jsonc
{
  "gateway": {
    // Enable gateway mode (default: true)
    "enabled": true,
    // Also emit the 30 legacy flat tool names for backward compat (default: true)
    "emitLegacyTools": true
  }
}
```

### Modes

| `enabled` | `emitLegacyTools` | Tools Registered | Use Case |
|:---------:|:-----------------:|:----------------:|:---------|
| `true` | `true` | 34 (4 gateway + 30 legacy) | Migration period — agents can use either style |
| `true` | `false` | 4 (gateway only) | Maximum token savings |
| `false` | — | 30 (flat only) | Backward compatibility, legacy agents |

Legacy tools include a deprecation notice in their description:
```
[Legacy — prefer sdl.query] Search for symbols by name or summary
```

---

## Implementation Details

### Module Structure

```
src/gateway/
  index.ts            # Registration orchestrator — registers 4 gateway + optional legacy
  router.ts           # Action routing — maps action names to { schema, handler } pairs
  schemas.ts          # Full Zod schemas — discriminated unions per namespace
  thin-schemas.ts     # Thin wire schemas — minimal JSON for tools/list
  descriptions.ts     # Compact tool descriptions — action reference cards
  compact-schema.ts   # $defs/$ref deduplicator for schema optimization
  legacy.ts           # Legacy tool aliases with deprecation notices
```

### Gateway Registration Flow

```typescript
// src/gateway/index.ts
export function registerGatewayTools(server, services, config) {
  const actionMap = createActionMap(services.liveIndex);

  // Register 4 gateway tools with thin wire schemas
  server.registerTool("sdl.query", QUERY_DESCRIPTION, QueryGatewaySchema,
    handler, QUERY_THIN_SCHEMA);
  server.registerTool("sdl.code", CODE_DESCRIPTION, CodeGatewaySchema,
    handler, CODE_THIN_SCHEMA);
  server.registerTool("sdl.repo", REPO_DESCRIPTION, RepoGatewaySchema,
    handler, REPO_THIN_SCHEMA);
  server.registerTool("sdl.agent", AGENT_DESCRIPTION, AgentGatewaySchema,
    handler, AGENT_THIN_SCHEMA);

  // Optional: also register 30 legacy tool names
  if (config.emitLegacyTools) {
    registerLegacyTools(server, services);
  }
}
```

### Router Logic

The gateway router (`src/gateway/router.ts`) performs the core dispatch:

```typescript
export async function routeGatewayCall(rawArgs, actionMap, ctx) {
  const { action, repoId, ...rest } = rawArgs;

  // Look up handler by action name
  const entry = actionMap[action];
  if (!entry) throw new Error(`Unknown gateway action: ${action}`);

  // Merge repoId back into params for handler compatibility
  const merged = repoId !== undefined ? { repoId, ...rest } : rest;

  // Second-pass validation using the original strict Zod schema
  const parsed = entry.schema.parse(merged);

  return entry.handler(parsed, ctx);
}
```

### Compact Schema Emitter

The `compact-schema.ts` module optimizes JSON Schemas for token efficiency:

1. **Strip descriptions** — `description` fields are redundant since the tool-level description contains the reference card
2. **Fingerprint sub-schemas** — canonicalize and hash every object node
3. **Deduplicate** — sub-schemas appearing 2+ times with size >40 chars are hoisted to `$defs` and replaced with `$ref` pointers

Example deduplication:
```json
// Before: repeated { "type": "number", "minimum": 0, "maximum": 1 } appears 4 times
// After: hoisted to $defs/d0, referenced as { "$ref": "#/$defs/d0" }
```

---

## CLI Integration

The gateway router is also used by the `sdl-mcp tool` command for direct CLI access. The CLI dispatcher calls `createActionMap()` directly, bypassing the MCP server entirely while sharing the same handler map.

See [CLI Tool Access](./cli-tool-access.md) for full CLI documentation.

---

## Migration Guide

### For MCP Client Users

If your agent configuration currently uses the flat tool names (e.g., `sdl.symbol.search`), you have two options:

1. **Do nothing** — Set `emitLegacyTools: true` (the default) and both flat and gateway tools are available
2. **Switch to gateway** — Update your agent instructions to use `sdl.query` with `action: "symbol.search"` instead of `sdl.symbol.search`

### For Agent Instruction Authors

Update your CLAUDE.md / AGENTS.md to use gateway-style calls:

```markdown
# Before (flat tools)
Use `sdl.symbol.search` to find symbols.
Use `sdl.code.getSkeleton` to see code structure.

# After (gateway tools)
Use `sdl.query` with `action: "symbol.search"` to find symbols.
Use `sdl.code` with `action: "code.getSkeleton"` to see code structure.
```

### Disabling Gateway Mode

If you need backward compatibility with older MCP clients:

```json
{
  "gateway": {
    "enabled": false
  }
}
```

This registers only the 30 flat tools, identical to pre-gateway behavior.

---

## Measuring Token Savings

Run the included measurement script to verify savings for your configuration:

```bash
npx tsx scripts/measure-gateway-schema-tokens.ts
```

Output:
```
=== SDL-MCP Gateway Schema Token Measurement ===

Flat mode:    30 tools, ~4250 tokens (~17000 chars)
Gateway mode: 4 tools, ~725 tokens (~2900 chars)
Hybrid mode:  33 tools

Gateway is ~17% of flat mode
Estimated savings: ~3525 tokens per tools/list call

✅ Gateway schema is within target (≤40% of flat)
```

---

## What's Next: Code Mode

Gateway mode optimizes **tool registration** overhead. **Code Mode** takes optimization further by eliminating **per-operation round-trip** overhead — batching entire context retrieval pipelines into a single tool call with `$N` inter-step references.

[Code Mode Deep Dive →](./code-mode.md)
