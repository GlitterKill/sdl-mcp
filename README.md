<div align="center">
<img src="https://github.com/GlitterKill/sdl-mcp/blob/main/docs/Symbol_Delta_Ledger_MCP.jpg" alt="Symbol Delta Ledger MCP">
</div>
<div align="center">
</div>

# SDL-MCP

[![npm version](https://img.shields.io/npm/v/sdl-mcp.svg)](https://www.npmjs.com/package/sdl-mcp) [![npm downloads](https://img.shields.io/npm/dm/sdl-mcp.svg)](https://www.npmjs.com/package/sdl-mcp) 

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
- Works across TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell

## ChatGPT-5.3-Codex XHigh Overview

Question: "Review code and explain what this MCP server does and the benefits of using it."

Response: "SDL‑MCP is a Model Context Protocol (MCP) server that turns your codebase into a queryable, versioned knowledge system for AI agents. Instead of “reading files,” agents interact with a set of structured tools that can register repositories, index them, and retrieve precise, high-signal context about what matters for a task.

At its core, SDL‑MCP builds and maintains a SQLite-backed symbol ledger: it indexes files, extracts symbols (names, kinds, locations, signatures, summaries), and records dependency relationships like imports and call edges. That foundation enables fast, repeatable navigation from a question (“where is this used?”) to the exact set of relevant code elements, without the noise and cost of full-file context.

On top of the ledger, SDL‑MCP provides practical developer workflows as tools: search for symbols, fetch a detailed “symbol card,” and automatically build focused graph slices that capture the most relevant surrounding code for a given task. It also supports deltas and blast-radius analysis between versions, plus PR risk analysis to help
prioritize what to review and what to test.

SDL‑MCP is built for responsible code access. When raw code is necessary, it offers graduated options—skeleton views (structure without full bodies), hot-path excerpts (only matching identifiers with context), and a policy-gated “need window” request for full code. Policies enforce limits and require intent signals (like identifiers), reducing overexposure while still enabling effective debugging when it’s justified.

The result is faster, cheaper, and safer agent assistance: less token burn, more relevant context, clearer change impact, and better governance through auditing of tool calls and policy decisions. It’s a code-intelligence layer that makes AI collaboration feel less like “chatting with a repo” and more like using a purpose-built engineering assistant."

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

# 2) Initialize repo (run from repo root folder)
sdl-mcp init --config "C:\[same path as SDL_CONFIG_HOME]"

# 3) Validate environment
sdl-mcp doctor

# 4) Build the symbol ledger (run from repo folder)
sdl-mcp index

# 5) Start MCP server (stdio for coding agents)
sdl-mcp serve --stdio

# 6) Copy the agent instructions from agent-workflows.md and paste them in the AGENTS.md file for your project.
```

## Core Feature Set

- Multi-language repository indexing with tree-sitter adapters
- Symbol cards with signatures, deps, metrics, and versioning
- Graph slices with handles, leases, refresh, and spillover
- Delta analysis and blast radius support
- Code access ladder: `getSkeleton` -> `getHotPath` -> `needWindow`
- Policy management (`sdl.policy.get` / `sdl.policy.set`)
- Repository overview and hotspot inspection (`sdl.repo.overview`)
- PR risk analysis (`sdl.pr.risk.analyze`)
- Agent orchestration tool (`sdl.agent.orchestrate`)
- Sync artifact export/import/pull workflows

## CLI Commands

- `init` - bootstrap config and optional client template
- `doctor` - validate runtime, config, DB path, grammars, repo access
- `index` - index repositories (optionally watch)
- `serve` - run MCP server (`--stdio` or `--http`)
- `export` - export sync artifact
- `import` - import sync artifact
- `pull` - pull by version/commit with fallback behavior
- `benchmark:ci` - run CI benchmark and threshold checks
- `version` - show version and environment info

## MCP Tools

- Repository: `sdl.repo.register`, `sdl.repo.status`, `sdl.repo.overview`, `sdl.index.refresh`
- Symbols: `sdl.symbol.search`, `sdl.symbol.getCard`
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
- [Legacy User Guide](./docs/USER_GUIDE.md)

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Benchmark tooling (npm scripts):

- `npm run benchmark:real`
- `npm run benchmark:matrix`
- `npm run benchmark:sweep`

## License

This project is **source-available**.

- **Free Use (Community License):** You may use, run, and modify this software for any purpose, including **internal business use**, under the terms in [`LICENSE`](./LICENSE).
- **Commercial Distribution / Embedding:** You must obtain a **commercial license** *before* you **sell, license, sublicense, bundle, embed, or distribute** this software (or a modified version) **as part of a for-sale or monetized product or offering**. See [`COMMERCIAL_LICENSE.md`](./COMMERCIAL_LICENSE.md).

If you're unsure whether your use is "Commercial Distribution / Embedding", contact **gmullins.gkc@gmail.com**.
