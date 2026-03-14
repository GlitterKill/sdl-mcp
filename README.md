<div align="center">
<img src="https://github.com/GlitterKill/sdl-mcp/blob/main/docs/Symbol_Delta_Ledger_MCP.jpg" alt="Symbol Delta Ledger MCP">

<br/>

# SDL-MCP

### **Cards-first code context for AI coding agents**

*Stop feeding entire files into the context window.<br/>Start giving agents exactly the code intelligence they need.*

<br/>

![npm version](https://img.shields.io/npm/v/sdl-mcp.svg)
![npm downloads](https://img.shields.io/npm/dm/sdl-mcp.svg)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/GlitterKill/sdl-mcp/ci.yml?label=CI%20Builds)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/GlitterKill/sdl-mcp/publish-native.yml?label=Rust%20Indexer%20Builds)
![GitHub commit activity](https://img.shields.io/github/commit-activity/w/GlitterKill/sdl-mcp)

</div>

---

<br/>

## What's the problem?

Every time an AI coding agent reads a file to answer a question, it consumes thousands of tokens. Most of those tokens are irrelevant to the task. The agent doesn't need 500 lines of a file to know that `validateToken` takes a `string` and returns a `Promise<User>` — but it reads them anyway, because that's all it has.

**Multiply that across a debugging session touching 20 files and you've burned 40,000+ tokens on context gathering alone.**

SDL-MCP fixes this. It indexes your codebase into a searchable **symbol graph** and serves precisely the right amount of context through a controlled escalation path. An agent that uses SDL-MCP understands your code better while consuming a fraction of the tokens.

<br/>

---

<br/>

## How it works — in 30 seconds

```
                Your Codebase
                     │
              ┌──────┴──────┐
              │   Indexer    │   Native Rust (fast) or Tree-sitter (universal)
              │   12 langs   │   TS · JS · Python · Go · Java · C# · C · C++ · PHP · Rust · Kotlin · Shell
              └──────┬──────┘
                     │
                     ▼
         ┌───────────────────────┐
         │   Symbol Graph (DB)   │   Functions, classes, interfaces, types, edges, metrics
         │   LadybugDB (graph)   │   Persisted. Incremental. Versioned.
         └───────────┬───────────┘
                     │
          ┌──────────┼──────────┐
          │          │          │
          ▼          ▼          ▼
      25 MCP      10 CLI    HTTP API
       Tools     Commands   + Graph UI
          │
          ▼
    AI Coding Agent
    (Claude Code, Claude Desktop, Cursor, Windsurf, any MCP client)
```

1. **Index once** — SDL-MCP parses every symbol in your repo and stores it as a compact metadata record (a "Symbol Card") in a graph database
2. **Query efficiently** — Agents use MCP tools to search, slice, and retrieve exactly the context they need
3. **Escalate only when necessary** — A four-rung ladder controls how much code the agent sees, from a 100-token card to full source (with justification required)

<br/>

---

<br/>

## Quick Start

```bash
# Install
npm install -g sdl-mcp

# Initialize, auto-detect languages, index your repo, and run health checks
sdl-mcp init -y --auto-index

# Start the MCP server for your coding agent
sdl-mcp serve --stdio
```

Point your MCP client at the server and the agent gains access to all SDL-MCP tools. That's it.

> **npx users:** Replace `sdl-mcp` with `npx --yes sdl-mcp@latest` in all commands above.

[Full Getting Started Guide →](./docs/getting-started.md)

<br/>

---

<br/>

## The Iris Gate Ladder

The core innovation. Named after the adjustable aperture that controls light flow in optics, the Iris Gate Ladder lets agents dial their context "aperture" from a pinhole to wide-open.

```
    Token Cost    What the Agent Sees
                  ────────────────────────────────────────────────
         ~100     RUNG 1 ▸ Symbol Card
                  Name, signature, summary, dependencies, metrics
                  "What does this function do and what does it call?"

         ~300     RUNG 2 ▸ Skeleton IR
                  Signatures + control flow, bodies replaced with /* ... */
                  "What's the shape of this class?"

         ~600     RUNG 3 ▸ Hot-Path Excerpt
                  Only lines matching specific identifiers + context
                  "Where exactly is `this.cache` initialized?"

       ~2,000     RUNG 4 ▸ Raw Code Window  Policy-gated
                  Full source code, requires justification
                  "I need to rewrite this error handler"
```

> **Most questions are answered at Rungs 1-2** without ever reading raw code. That's where the token savings come from.

| Scenario | Reading the file | Using the Ladder | Savings |
|:---------|:----------------:|:----------------:|:-------:|
| "What does `parseConfig` accept?" | ~2,000 tok | ~100 tok | **20x** |
| "Show me the shape of `AuthService`" | ~4,000 tok | ~300 tok | **13x** |
| "Where is `this.cache` set?" | ~2,000 tok | ~500 tok | **4x** |

[Iris Gate Ladder Deep Dive →](./docs/feature-deep-dives/iris-gate-ladder.md)

<br/>

---

<br/>

## Feature Tour

### Symbol Cards — The Atoms of Understanding

Every function, class, interface, type, and variable becomes a **Symbol Card**: a compact metadata record (~100 tokens) containing everything an agent needs to *understand* a symbol without reading its code.

```
  ┌─────────────────────────────────────────────────────────┐
  │  Symbol Card: validateToken                             │
  │─────────────────────────────────────────────────────────│
  │  Kind:       function (exported)                        │
  │  File:       src/auth/jwt.ts:42-67                      │
  │  Signature:  (token: string, opts?: ValidateOpts)       │
  │              → Promise<DecodedToken>                    │
  │  Summary:    Validates JWT signature and expiration,    │
  │              returns decoded payload or throws          │
  │  Invariants: ["throws on expired token"]                │
  │  Side FX:    ["logs to audit trail"]                    │
  │  Deps:       calls: [verifySignature, checkExpiry]      │
  │              imports: [jsonwebtoken, AuditLogger]        │
  │  Metrics:    fan-in: 12 │ fan-out: 4 │ churn: 3/30d    │
  │  Cluster:    auth-module (8 members)                    │
  │  Process:    request-pipeline (intermediate, depth 1)   │
  │  Test:       auth.test.ts (distance: 1, proximity: 0.9)│
  │  ETag:       a7f3c2... (for conditional requests)       │
  └─────────────────────────────────────────────────────────┘
```

Cards include **confidence-scored call resolution** (the pass-2 resolver traces imports, aliases, barrel re-exports, and tagged templates to produce accurate dependency edges), **community detection** (cluster membership), and **call-chain tracing** (process participation with entry/intermediate/exit roles).

[Indexing & Language Support Deep Dive →](./docs/feature-deep-dives/indexing-languages.md)

---

### Graph Slicing — The Right Context for Every Task

Instead of reading files in the same directory, SDL-MCP follows the *dependency graph*. Starting from symbols relevant to your task, it traverses weighted edges (call: 1.0, config: 0.8, import: 0.6), scores each symbol by relevance, and returns the N most important within a token budget.

```
  "Fix the auth middleware"     →   slice.build
                                         │
                                    BFS over graph
                                         │
                      ┌──────────────────┼──────────────────┐
                      ▼                  ▼                  ▼
                 authenticate      validateToken        JwtConfig
                      │                  │                  │
                      ▼                  ▼                  ▼
                 hashPassword       getUserById         envLoader
                                                            │
                                                         ◆ frontier
                                                    (outside budget)

                 8 cards returned  ·  ~800 tokens
            vs.  reading 8 files  ·  ~16,000 tokens
```

Slices have handles, leases, refresh (delta-only updates), and spillover (paged overflow). You can also skip the symbol search entirely — pass a `taskText` string and SDL-MCP auto-discovers the relevant entry symbols.

[Graph Slicing Deep Dive →](./docs/feature-deep-dives/graph-slicing.md)

---

### Delta Packs & Blast Radius — Semantic Change Intelligence

`git diff` tells you what lines changed. SDL-MCP tells you what that change *means* and who's affected.

```
  Modified: validateToken() signature
       │
       ├── signatureDiff: added `options?: object` parameter
       ├── invariantDiff: added "throws on expired"
       └── sideEffectDiff: added "logs to audit trail"
              │
              ▼
       Blast Radius (ranked):
       1. authenticate()    ← direct caller, distance 1
       2. refreshSession()  ← direct caller, distance 1
       3. AuthMiddleware     ← calls authenticate, distance 2
       4. auth.test.ts      ← test coverage, flagged for re-run
```

**PR risk analysis** (`sdl.pr.risk.analyze`) wraps this into a scored assessment with findings, evidence, and test recommendations. **Fan-in trend analysis** detects "amplifier" symbols whose growing dependency count means changes ripple further over time.

[Delta & Blast Radius Deep Dive →](./docs/feature-deep-dives/delta-blast-radius.md)

---

### Live Indexing — Real-Time Code Intelligence

SDL-MCP doesn't wait for you to save. As you type in your editor, buffer updates are pushed to an in-memory overlay store, parsed in the background, and merged with the durable database. Search, cards, and slices reflect your *current* code, not your last save.

```
  Editor keystrokes → sdl.buffer.push → Overlay Store → merged reads
                                              │
                                         on save / idle
                                              │
                                              ▼
                                        LadybugDB (durable)
```

[Live Indexing Deep Dive →](./docs/feature-deep-dives/live-indexing.md)

---

### Governance & Policy — Controlled Access

Raw code access (Rung 4) is **policy-gated**. Agents must provide:
- A **reason** explaining why they need raw code
- **Identifiers** they expect to find in the code
- An **expected line count** within configured limits

Requests that don't meet policy are denied with actionable guidance ("try `getHotPath` with these identifiers instead"). Every access is audit-logged.

The sandboxed runtime execution tool (`sdl.runtime.execute`) has its own governance layer: disabled by default, executable allowlisting, CWD jailing, environment scrubbing, concurrency limits, and timeout enforcement.

[Governance & Policy Deep Dive →](./docs/feature-deep-dives/governance-policy.md)

---

### Agent Orchestration — Autopilot Mode

`sdl.agent.orchestrate` is an autonomous task engine. Give it a task type (`debug`, `review`, `implement`, `explain`), a description, and a budget — it plans the optimal Iris Gate path, executes it, collects evidence, and returns a synthesized answer.

The feedback loop (`sdl.agent.feedback`) records which symbols were useful and which were missing, improving future slice quality.

`sdl.context.summary` generates portable, token-bounded context briefings in markdown, JSON, or clipboard format for use outside MCP environments.

[Agent Orchestration Deep Dive →](./docs/feature-deep-dives/agent-orchestration.md)

---

### Sandboxed Runtime Execution

Run tests, linters, and scripts through SDL-MCP's governance layer instead of uncontrolled shell access. Three runtimes (Node.js, Python, Shell), code-mode or args-mode, smart output summarization with keyword-matched excerpts, and gzip artifact persistence.

[Runtime Execution Deep Dive →](./docs/feature-deep-dives/runtime-execution.md)

<br/>

---

<br/>

## All 25 MCP Tools at a Glance

<table>
<tr><th>Category</th><th>Tool</th><th>One-Line Description</th></tr>
<tr><td rowspan="4"><strong>Repository</strong></td>
    <td><code>sdl.repo.register</code></td><td>Register a codebase for indexing</td></tr>
<tr><td><code>sdl.repo.status</code></td><td>Health, versions, watcher, prefetch, live-index stats</td></tr>
<tr><td><code>sdl.repo.overview</code></td><td>Codebase summary: stats, directories, hotspots, clusters</td></tr>
<tr><td><code>sdl.index.refresh</code></td><td>Trigger full or incremental re-indexing</td></tr>

<tr><td rowspan="3"><strong>Live Buffer</strong></td>
    <td><code>sdl.buffer.push</code></td><td>Push unsaved editor content for real-time indexing</td></tr>
<tr><td><code>sdl.buffer.checkpoint</code></td><td>Force-write pending buffers to the durable database</td></tr>
<tr><td><code>sdl.buffer.status</code></td><td>Live indexing diagnostics and queue depth</td></tr>

<tr><td rowspan="3"><strong>Symbols</strong></td>
    <td><code>sdl.symbol.search</code></td><td>Search symbols by name (with optional semantic reranking)</td></tr>
<tr><td><code>sdl.symbol.getCard</code></td><td>Get a symbol card with ETag-based conditional support</td></tr>
<tr><td><code>sdl.symbol.getCards</code></td><td>Batch-fetch up to 100 cards in one round trip</td></tr>

<tr><td rowspan="3"><strong>Slices</strong></td>
    <td><code>sdl.slice.build</code></td><td>Build a task-scoped dependency subgraph</td></tr>
<tr><td><code>sdl.slice.refresh</code></td><td>Delta-only update of an existing slice</td></tr>
<tr><td><code>sdl.slice.spillover.get</code></td><td>Page through overflow symbols beyond the budget</td></tr>

<tr><td rowspan="3"><strong>Code Access</strong></td>
    <td><code>sdl.code.getSkeleton</code></td><td>Signatures + control flow, bodies elided</td></tr>
<tr><td><code>sdl.code.getHotPath</code></td><td>Lines matching specific identifiers + context</td></tr>
<tr><td><code>sdl.code.needWindow</code></td><td>Full source code (policy-gated, requires justification)</td></tr>

<tr><td><strong>Deltas</strong></td>
    <td><code>sdl.delta.get</code></td><td>Semantic diff + blast radius between versions</td></tr>

<tr><td rowspan="2"><strong>Policy</strong></td>
    <td><code>sdl.policy.get</code></td><td>Read current gating policy</td></tr>
<tr><td><code>sdl.policy.set</code></td><td>Update line/token limits and identifier requirements</td></tr>

<tr><td><strong>Risk</strong></td>
    <td><code>sdl.pr.risk.analyze</code></td><td>Scored PR risk with findings and test recommendations</td></tr>

<tr><td><strong>Context</strong></td>
    <td><code>sdl.context.summary</code></td><td>Token-bounded portable briefing (markdown/JSON/clipboard)</td></tr>

<tr><td rowspan="3"><strong>Agent</strong></td>
    <td><code>sdl.agent.orchestrate</code></td><td>Autonomous task execution with budget control</td></tr>
<tr><td><code>sdl.agent.feedback</code></td><td>Record which symbols were useful or missing</td></tr>
<tr><td><code>sdl.agent.feedback.query</code></td><td>Query aggregated feedback statistics</td></tr>

<tr><td><strong>Runtime</strong></td>
    <td><code>sdl.runtime.execute</code></td><td>Sandboxed subprocess execution (Node/Python/Shell)</td></tr>
</table>

[Complete MCP Tools Reference (detailed parameters & responses) →](./docs/mcp-tools-detailed.md)

<br/>

---

<br/>

## CLI Commands

| Command | Description |
|:--------|:------------|
| `sdl-mcp init` | Bootstrap config, detect repo/languages, optionally auto-index |
| `sdl-mcp doctor` | Validate runtime, config, DB, grammars, repo access |
| `sdl-mcp index` | Index repositories (with optional `--watch` mode) |
| `sdl-mcp serve` | Start MCP server (`--stdio` or `--http`) |
| `sdl-mcp summary` | Generate copy/paste context summaries from the CLI |
| `sdl-mcp health` | Compute composite health score with badge/JSON output |
| `sdl-mcp export` | Export sync artifact |
| `sdl-mcp import` | Import sync artifact |
| `sdl-mcp pull` | Pull by version/commit with fallback |
| `sdl-mcp version` | Show version and environment info |

[CLI Reference →](./docs/cli-reference.md) · [Configuration Reference →](./docs/configuration-reference.md)

<br/>

---

<br/>

## Compatible With

SDL-MCP works with any MCP-compatible client:

| Client | Transport | Setup |
|:-------|:----------|:------|
| **Claude Code** | stdio | `sdl-mcp init --client claude-code` |
| **Claude Desktop** | stdio | `sdl-mcp init --client claude-code` |
| **Cursor** | stdio | Standard MCP server config |
| **Windsurf** | stdio | Standard MCP server config |
| **Codex CLI** | stdio | `sdl-mcp init --client codex` |
| **Gemini CLI** | stdio | `sdl-mcp init --client gemini` |
| **OpenCode** | stdio | `sdl-mcp init --client opencode` |
| **Any MCP client** | stdio / http | `sdl-mcp serve --stdio` or `--http` |

A **VSCode extension** (`sdl-mcp-vscode/`) provides live buffer integration for real-time indexing of unsaved edits.

<br/>

---

<br/>

## Tech Stack

| Component | Technology |
|:----------|:-----------|
| Runtime | Node.js 20+ / TypeScript 5.9+ (strict ESM) |
| Graph Database | LadybugDB (embedded, single-file) |
| Indexer (default) | Rust via napi-rs (multi-threaded) |
| Indexer (fallback) | tree-sitter + tree-sitter-typescript |
| MCP SDK | @modelcontextprotocol/sdk |
| Validation | Zod schemas for all payloads |
| Transports | stdio (agents) · HTTP (dev/network) |

<br/>

---

<br/>

## Documentation

| Document | Description |
|:---------|:------------|
| [Getting Started](./docs/getting-started.md) | Installation, 5-minute setup, MCP client config |
| [MCP Tools Reference](./docs/mcp-tools-detailed.md) | Detailed docs for all 25 tools (parameters, responses, examples) |
| [CLI Reference](./docs/cli-reference.md) | All CLI commands and options |
| [Configuration Reference](./docs/configuration-reference.md) | Every config option with defaults and guidance |
| [Agent Workflows](./docs/agent-workflows.md) | Workflow instructions for CLAUDE.md / AGENTS.md |
| [Architecture](./docs/ARCHITECTURE.md) | Tech stack, data flow, component diagram |
| [Iris Gate Ladder](./docs/IRIS_GATE_LADDER.md) | Context escalation methodology |
| [Troubleshooting](./docs/troubleshooting.md) | Common issues and fixes |

### Feature Deep Dives

| Topic | What You'll Learn |
|:------|:------------------|
| [Iris Gate Ladder](./docs/feature-deep-dives/iris-gate-ladder.md) | Four-rung context escalation with token savings analysis |
| [Graph Slicing](./docs/feature-deep-dives/graph-slicing.md) | BFS/beam search, edge weights, wire formats, auto-discovery |
| [Delta & Blast Radius](./docs/feature-deep-dives/delta-blast-radius.md) | Semantic diffs, ranked impact analysis, PR risk scoring |
| [Live Indexing](./docs/feature-deep-dives/live-indexing.md) | Real-time editor buffer integration and overlay architecture |
| [Governance & Policy](./docs/feature-deep-dives/governance-policy.md) | Proof-of-need gating, audit logging, runtime sandboxing |
| [Agent Orchestration](./docs/feature-deep-dives/agent-orchestration.md) | Autopilot mode, feedback loops, portable context summaries |
| [Indexing & Languages](./docs/feature-deep-dives/indexing-languages.md) | Rust/TS engines, two-pass architecture, 12-language support |
| [Runtime Execution](./docs/feature-deep-dives/runtime-execution.md) | Sandboxed subprocess execution with governance |
| [Semantic Engine](./docs/feature-deep-dives/semantic-engine.md) | Pass-2 call resolution, embedding search, LLM summaries, confidence scoring |

<br/>

---

<br/>

## License

This project is **source-available**.

- **Free Use (Community License):** You may use, run, and modify this software for any purpose, including **internal business use**, under the terms in [`LICENSE`](./LICENSE).
- **Commercial Distribution / Embedding:** You must obtain a **commercial license** before you **sell, license, sublicense, bundle, embed, or distribute** this software as part of a for-sale or monetized product. See [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md).

Questions? Contact **gmullins.gkc@gmail.com**.
