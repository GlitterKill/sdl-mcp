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

SDL-MCP (Symbol Delta Ledger MCP Server) is a cards-first context system for coding agents.

Instead of opening large files first, SDL-MCP indexes repositories into symbol cards and graph edges so agents can:

- Search and retrieve small, structured context first
- Build task-specific graph slices with token budgets
- Refresh context with deltas between versions
- Request code windows through policy-gated access

## Why It Helps Coding Agents

- Lower token usage by default through cards/slices/skeletons
- Better relevance with dependency-aware context retrieval
- Safer context access via policy controls and auditing
- Faster iteration through incremental indexing and refresh workflows
- KuzuDB-backed graph persistence means indexing happens once, not every session
- Confidence-aware call resolution filtering and pass2 provenance in symbol cards and slices
- Works across TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell

## Claude Opus 4.6 High Overview

Question: "Review the code for SDL-MCP and explain to potential new users what this MCP server does and the benefits of
  using it."

Response: "# What is SDL-MCP?

  **SDL-MCP** (Symbol Delta Ledger - Model Context Protocol) is an MCP server that fundamentally changes how AI coding
  assistants interact with your codebase. Instead of dumping entire files into the AI's context window, SDL-MCP provides
   a structured, token-efficient way to give AI agents exactly the code context they need — and nothing more.

  ---

  ## The Problem It Solves

  When AI assistants like Claude work with code, they typically read entire files — sometimes many files — to understand
   enough context to help you. This is wasteful:

  - **Context windows fill up fast.** A modest codebase can easily exceed token limits.
  - **Irrelevant code dilutes focus.** The AI spends tokens processing code unrelated to your task.
  - **No awareness of what changed.** Every interaction starts from scratch with no incremental understanding.

  SDL-MCP addresses all three by maintaining a **persistent, indexed understanding** of your codebase and serving
  context through a 4-rung escalation ladder.

  ---

  ## How It Works

  ### 1. Symbol Indexing

  SDL-MCP parses your TypeScript/JavaScript codebase using a Rust native indexer by default, with the TypeScript tree-sitter path as fallback, and extracts
   every function, class, interface, type, and variable into **Symbol Cards** — compact metadata records containing the
  symbol's signature, a brief summary, dependency edges, and metrics like fan-in/out.

  The stats speak for themselves: this repository has **11,475 symbols** across **1,553 files** with **261,813
  dependency edges** tracked. A full card dump would cost ~2.3M tokens. The overview costs **825 tokens** — a **2,782x
  compression ratio**.

  ### 2. The Context Ladder (4 Rungs)

  Instead of "here's the whole file," SDL-MCP provides context in escalating detail:

  | Rung | What You Get | Token Cost | When Used |
  |------|-------------|------------|-----------|
  | **Symbol Cards** | Name, signature, summary, dependencies | ~50 tokens | Always start here |
  | **Skeleton IR** | Signatures + control flow, bodies elided | ~200 tokens | Understanding structure |
  | **Hot-Path Excerpt** | Only lines matching specific identifiers | ~500 tokens | Finding specific logic |
  | **Full Code Window** | Complete source (gated, requires justification) | ~2,000 tokens | Last resort |

  Most questions can be answered at rungs 1-2 without ever reading raw code.

  ### 3. Graph Slices

  When an AI needs to understand context around a task, SDL-MCP builds a **task-scoped subgraph** — a slice of related
  symbols connected by call, import, and config edges, scored by relevance and bounded by a token budget. This means the
   AI gets the 20-30 most relevant symbols for a task, not an arbitrary directory listing.

  ### 4. Delta Packs

  When code changes, SDL-MCP computes **diffs at the symbol level** — not line-level diffs, but semantic changes to
  signatures, invariants, and side effects. It also computes a **blast radius**: which other symbols are affected by the
   change, ranked by proximity and importance.

  ### 5. Proof-of-Need Gating

  Raw code access requires justification. The AI must specify *why* it needs the code, *what identifiers* it expects to
  find, and *how many lines* it needs. Requests are audited. This prevents lazy "just read the whole file" patterns and
  keeps token usage disciplined.

  ---

  ## Key Benefits

  **For AI-assisted development:**

  - **10-50x fewer tokens** per coding task compared to reading raw files
  - **More relevant context** — graph-based slicing finds related code that directory-based approaches miss
  - **Incremental understanding** — delta packs mean the AI doesn't re-read unchanged code
  - **Audit trail** — every raw code access is logged with justification

  **For large codebases:**

  - Scales to thousands of files without blowing context windows
  - Symbol-level tracking survives whitespace changes and trivial refactors
  - KuzuDB-backed graph persistence means indexing happens once, not every session

  **For teams:**

  - Consistent context governance via configurable policies
  - Blast radius analysis shows the ripple effects of changes before they land
  - Works as a standard MCP server — compatible with any MCP-capable client

  ---

  ## Practical Setup

  SDL-MCP runs as a CLI with 5 commands:

  ```bash
  sdl-mcp init      # Create config + graph DB path
  sdl-mcp index     # Index your repositories
  sdl-mcp serve     # Start the MCP server (stdio or HTTP)
  sdl-mcp doctor    # Health check
  sdl-mcp version   # Version info

  Once running, any MCP client (Claude Code, Claude Desktop, etc.) connects to it and gains access to 13 tools for
  navigating your codebase efficiently.

  ---
  In Summary

  SDL-MCP is a code context server that treats your codebase like a searchable knowledge graph rather than a pile of
  text files. It gives AI assistants surgical access to exactly what they need, dramatically reducing token waste while
  improving the quality of code understanding. Think of it as giving your AI a proper IDE-level understanding of your
  code, rather than having it grep through files."

## Quick Start

### Install

```bash
npm install -g sdl-mcp
```

Or run without global install:

```bash
npx --yes sdl-mcp@latest version
```

### Configure and Initialize

```bash
# Tip: If you are using npx, replace `sdl-mcp` with `npx --yes sdl-mcp@latest`.
# 1) Set config location variable then open a new terminal
setx SDL_CONFIG_HOME "C:\[your path]"

# 2) One-line non-interactive setup (includes inline index + doctor)
sdl-mcp init -y --auto-index --config "C:\[same path as SDL_CONFIG_HOME]"

# 3) Start MCP server (stdio for coding agents)
sdl-mcp serve --stdio

# Optional: start HTTP transport for graph explorer + REST endpoints
sdl-mcp serve --http --host localhost --port 3000

# Optional: disable watch mode if your environment has watcher instability
sdl-mcp serve --stdio --no-watch

# 4) Copy the agent instructions from agent-workflows.md and paste them in the AGENTS.md file for your project.
```

## Core Feature Set

- Multi-language repository indexing with tree-sitter adapters
- Native Rust pass-1 indexing engine by default (`indexing.engine: "rust"`, with TypeScript fallback)
- Live editor-buffer indexing with draft-aware symbol/search/slice reads, save-time Kuzu patching, background reconciliation, and automatic checkpoint compaction (`liveIndex.*`)
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
- **Commercial Distribution / Embedding:** You must obtain a **commercial license** *before* you **sell, license, sublicense, bundle, embed, or distribute** this software (or a modified version) **as part of a for-sale or monetized product or offering**. See [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md).

If you're unsure whether your use is "Commercial Distribution / Embedding", contact **gmullins.gkc@gmail.com**.
