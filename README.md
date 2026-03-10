<div align="center">
<img src="https://github.com/GlitterKill/sdl-mcp/blob/main/docs/Symbol_Delta_Ledger_MCP.jpg" alt="Symbol Delta Ledger MCP">
</div>
<div align="center">
</div>

# SDL-MCP

![npm version](https://img.shields.io/npm/v/sdl-mcp.svg) ![npm downloads](https://img.shields.io/npm/dm/sdl-mcp.svg) ![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/GlitterKill/sdl-mcp/ci.yml?label=CI%20Builds)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/GlitterKill/sdl-mcp/publish-native.yml?label=Rust%20Indexer%20Builds) ![GitHub commit activity](https://img.shields.io/github/commit-activity/w/GlitterKill/sdl-mcp)

<div align="right">
<details>
<summary><strong>Documentation</strong></summary>

- [Overview (this page)](./README.md)
- [Documentation Hub](./docs/README.md)
  - [Getting Started](./docs/getting-started.md)
  - [CLI Reference](./docs/cli-reference.md)
  - [MCP Tools Reference](./docs/mcp-tools-reference.md)
  - [Configuration Reference](./docs/configuration-reference.md)
  - [Agent Workflows](./docs/agent-workflows.md)
  - [Troubleshooting](./docs/troubleshooting.md)
- [Legacy User Guide](./docs/USER_GUIDE.md)

</details>
</div>

## Claude Opus 4.6 High Overview

Question: "Review the code for SDL-MCP and explain to potential new users what this MCP server does and the benefits of
using it."

Response: "# What is SDL-MCP?

**SDL-MCP** (Symbol Delta Ledger - Model Context Protocol) is an MCP server that gives AI coding agents a structured,
token-efficient way to understand your codebase. Instead of feeding entire files into the context window, SDL-MCP
indexes your repository into a **searchable knowledge graph** of symbols and their relationships, then serves exactly
the right amount of context through a controlled escalation path.

It ships as an npm package (`npm install -g sdl-mcp`) with a CLI for setup and a server that any MCP-compatible client
(Claude Code, Claude Desktop, etc.) can connect to.

---

## The Problem It Solves

When AI assistants work with code, they typically read whole files — often many of them — to gather enough context.
This has three costs:

1. **Context windows fill up fast.** A modest codebase can exceed token limits quickly.
2. **Irrelevant code dilutes focus.** Tokens are spent on code unrelated to the task.
3. **No incremental understanding.** Every interaction starts fresh with no memory of what was already analyzed.

SDL-MCP addresses all three by maintaining a **persistent, indexed graph** of your codebase and controlling context
retrieval through the **Iris Gate Ladder**.

---

## How It Works

### 1. Repository Indexing

SDL-MCP parses your codebase using either a **native Rust indexer** (default, fast, multi-threaded) or a **tree-sitter
TypeScript fallback**, and extracts every function, class, interface, type, and variable into **Symbol Cards** —
compact metadata records containing signatures, summaries, dependency edges, and metrics like fan-in/out.

**12 languages supported:** TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell.

Indexing happens once and is persisted in a **LadybugDB embedded graph database**. Incremental re-indexing picks up only
what changed.

### 2. The Iris Gate Ladder (4 Rungs)

Context is served in escalating detail — agents start small and only request more when needed:

| Rung                    | Tool                   | ~Tokens     | What It Provides                                |
| :---------------------- | :--------------------- | :---------- | :---------------------------------------------- |
| **1. Symbol Cards**     | `sdl.symbol.getCard`   | 50–150      | Name, signature, summary, dependencies, metrics |
| **2. Skeleton IR**      | `sdl.code.getSkeleton` | 200–400     | Signatures + control flow, bodies elided        |
| **3. Hot-Path Excerpt** | `sdl.code.getHotPath`  | 400–800     | Lines matching specific identifiers + context   |
| **4. Raw Code Window**  | `sdl.code.needWindow`  | 1,000–4,000 | Full source code (policy-gated, requires        |
| justification)          |

> [!TIP]
> Most questions are answered at rungs 1–2 without ever reading raw code.

### 3. Graph Slices

When the agent needs broader context for a task, `sdl.slice.build` performs a **BFS/beam search** from entry symbols
across weighted dependency edges (call > config > import), bounded by a token budget. The result is the 20–30 most
relevant symbols for the task — not an arbitrary directory listing.

### 4. Delta Packs & Blast Radius

When code changes, SDL-MCP computes **semantic diffs at the symbol level** — not line-level diffs, but changes to
signatures, invariants, and side effects. It also computes a **blast radius**: which other symbols are affected,
ranked by proximity, fan-in, and test coverage.

### 5. Proof-of-Need Gating

Raw code access (rung 4) requires the agent to justify _why_ it needs the code, _what identifiers_ it expects to find,
and _how many lines_. Requests are audited. This enforces disciplined token usage.

---

## Key Benefits

### Token Efficiency

- **10–50x fewer tokens** per coding task compared to reading raw files
- **2,782x compression ratio** for a repository overview vs. a full card dump

### Better Relevance

- Graph-based slicing finds related code that directory-based approaches miss
- Confidence-scored call resolution filters noise from low-confidence edges

### Incremental Understanding

- Delta packs mean the agent doesn't re-read unchanged code
- Slice handles with leases and refresh support avoid rebuilding context from scratch

### Governance & Auditability

- Configurable policies control what agents can access
- Every raw code request is logged with justification
- Blast radius analysis shows ripple effects before changes land

### Multi-Language

- 12 language adapters with a generalized pass-2 resolver for cross-file semantic resolution

---

## Feature Summary

| Category            | Features                                                                                            |
| :------------------ | :-------------------------------------------------------------------------------------------------- |
| **Indexing**        | Native Rust + tree-sitter fallback, incremental indexing, live editor-buffer overlay, file watching |
| **Context**         | Symbol cards, skeleton IR, hot-path excerpts, gated raw windows                                     |
| **Graph**           | Slices with handles/leases/refresh/spillover, cluster detection, call-chain tracing                 |
| **Change Tracking** | Delta packs, blast radius analysis, PR risk scoring                                                 |
| **Intelligence**    | Semantic search reranking, LLM-generated summaries, predictive prefetch                             |
| **Governance**      | Policy engine, proof-of-need gating, audit logging                                                  |
| **Agent Support**   | `sdl.agent.orchestrate` autopilot, `sdl.context.summary` for copy/paste context                     |
| **Tools**           | 17+ MCP tools, 10 CLI commands, HTTP API with graph explorer UI                                     |
| **Integrations**    | VSCode extension, Claude Code/Desktop, any MCP client                                               |

---

## Getting Started

```bash
# Install globally
npm install -g sdl-mcp

# Initialize config + index your repo
sdl-mcp init -y --auto-index

# Start the MCP server
sdl-mcp serve --stdio

Then point your MCP client at the server — the agent gains access to all SDL-MCP tools and can navigate your codebase
through the Iris Gate Ladder instead of bulk file reads.

[!NOTE]
See the full ./docs/getting-started.md and ./docs/mcp-tools-reference.md for detailed setup and usage instructions.

```

## Core Feature Set

- Multi-language repository indexing with tree-sitter adapters
- Native Rust pass-1 indexing engine by default (`indexing.engine: "rust"`, with TypeScript fallback)
- Live editor-buffer indexing with draft-aware symbol/search/slice reads, save-time LadybugDB patching, background reconciliation, and automatic checkpoint compaction (`liveIndex.*`)
- Symbol cards with signatures, deps, metrics, and versioning
- Graph slices with handles, leases, refresh, and spillover
- Graph enrichment: clusters (community detection) + processes (call-chain traces) surfaced in cards/slices/overview/blast radius
- Generalized pass2 resolver registry with TypeScript/JavaScript semantic pass2 plus Go pass2, and confidence-scored call metadata available through `symbol.getCard` and `slice.build`
- Delta analysis and blast radius support with amplifier scoring
- Semantic symbol search reranking (`sdl.symbol.search` with `semantic: true`)
- LLM-generated symbol summaries with configurable concurrency and batching (`semantic.summaryModel`, `summaryMaxConcurrency`, `summaryBatchSize`)
- Code access ladder: `getSkeleton` -> `getHotPath` -> `needWindow`
- Policy management (`sdl.policy.get` / `sdl.policy.set`)
- Repository overview and hotspot inspection (`sdl.repo.overview`)
- PR risk analysis (`sdl.pr.risk.analyze`)
- Agent orchestration tool (`sdl.agent.orchestrate`)
- Predictive prefetch heuristics with status metrics (`prefetchStats`)
- File watch debouncing for efficient incremental indexing (`indexing.watchDebounceMs`)
- Live overlay controls for editor-buffer parsing and idle checkpointing (`liveIndex.debounceMs`, `liveIndex.idleCheckpointMs`, `liveIndex.maxDraftFiles`)
- Canonical test mapping in symbol cards (`metrics.canonicalTest`)
- Graph HTTP surface and browser explorer (`/api/graph/*`, `/ui/graph`)
- VSCode extension MVP in `sdl-mcp-vscode/`
- Sync artifact export/import/pull workflows

## CLI Commands

- `init` - bootstrap config and optional client template
- `doctor` - validate runtime, config, DB path, grammars, repo access, and call-resolution capabilities
- `index` - index repositories (optionally watch)
- `serve` - run MCP server (`--stdio` or `--http`)
- `export` - export sync artifact
- `import` - import sync artifact
- `pull` - pull by version/commit with fallback behavior
- `benchmark:ci` - run CI benchmark checks, including edge-accuracy regression gating
- `summary` - generate token-bounded copy/paste context summaries
- `health` - compute composite index health score and badge/json output
- `version` - show version and environment info

## MCP Tools

- Repository: `sdl.repo.register`, `sdl.repo.status`, `sdl.repo.overview`, `sdl.index.refresh`
- Symbols: `sdl.symbol.search`, `sdl.symbol.getCard`
- Context: `sdl.context.summary`
- Slice: `sdl.slice.build`, `sdl.slice.refresh`, `sdl.slice.spillover.get`
- Delta: `sdl.delta.get`
- Code: `sdl.code.needWindow`, `sdl.code.getSkeleton`, `sdl.code.getHotPath`
- Policy: `sdl.policy.get`, `sdl.policy.set`
- Risk/Agent: `sdl.pr.risk.analyze`, `sdl.agent.orchestrate`

See: [MCP Tools Reference](./docs/mcp-tools-reference.md)

## Documentation

- [Documentation Hub](./docs/README.md)
- [Iris Gate Ladder](./docs/IRIS_GATE_LADDER.md) - Context escalation methodology
- [Architecture](./docs/ARCHITECTURE.md) - Tech stack and data flow
- [Getting Started](./docs/getting-started.md)
- [CLI Reference](./docs/cli-reference.md)
- [MCP Tools Reference](./docs/mcp-tools-reference.md)
- [Configuration Reference](./docs/configuration-reference.md)
- [Agent Workflows](./docs/agent-workflows.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [VSCode Extension README](./sdl-mcp-vscode/README.md)
- [Legacy User Guide](./docs/USER_GUIDE.md)

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm test
# Optional native addon + parity checks
npm run build:native
npm run test:native-parity
```

Benchmark tooling (npm scripts):

- `npm run benchmark:real`
- `npm run benchmark:matrix`
- `npm run benchmark:sweep`

Phase A benchmark lockfile:

- `scripts/benchmark/phase-a-benchmark-lock.json` pins TS/Python/Tier-3 repos for reproducible baseline runs.

## License

This project is **source-available**.

- **Free Use (Community License):** You may use, run, and modify this software for any purpose, including **internal business use**, under the terms in [`LICENSE`](./LICENSE).
- **Commercial Distribution / Embedding:** You must obtain a **commercial license** _before_ you **sell, license, sublicense, bundle, embed, or distribute** this software (or a modified version) **as part of a for-sale or monetized product or offering**. See [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md).

If you're unsure whether your use is "Commercial Distribution / Embedding", contact **gmullins.gkc@gmail.com**.
