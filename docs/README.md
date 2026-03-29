# Documentation Hub

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub (this page)](./README.md)
  - [Iris Gate Ladder](./feature-deep-dives/iris-gate-ladder.md)
  - [Architecture](./architecture.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Tool Enforcement](./tool-enforcement.md)
  - [Troubleshooting](./troubleshooting.md)

</details>
</div>

Use this page as the entry point for SDL-MCP documentation.

## Read By Goal

- I want to understand the technical stack and data flow:
  - [Architecture](./architecture.md)
- I want to install and run SDL-MCP quickly:
  - [Getting Started](./getting-started.md)
- I need command syntax and examples:
  - [CLI Reference](./cli-reference.md)
- I need MCP tool payloads and responses:
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [MCP Tools Detailed](./mcp-tools-detailed.md)
- I need to tune repository, policy, and slice behavior:
  - [Configuration Reference](./configuration-reference.md)
- I want agent best practices and Iris Gate Ladder workflows:
  - [Agent Workflows](./agent-workflows.md)
  - [Iris Gate Ladder](./feature-deep-dives/iris-gate-ladder.md)
- I want agents to actually use SDL-MCP instead of native token-heavy tools:
  - [Tool Enforcement](./tool-enforcement.md)
  - [Claude-Specific Enforcement](./tool-enforcement-for-claude.md)
- I need operational debugging guidance:
  - [Troubleshooting](./troubleshooting.md)
- I want to understand the memory protocol:
  - [Memory Protocol](./memory-protocol.md)

## Feature Deep-Dives

- [Iris Gate Ladder](./feature-deep-dives/iris-gate-ladder.md)
- [Graph Slicing](./feature-deep-dives/graph-slicing.md)
- [Delta & Blast Radius](./feature-deep-dives/delta-blast-radius.md)
- [Live Indexing](./feature-deep-dives/live-indexing.md)
- [Governance & Policy](./feature-deep-dives/governance-policy.md)
- [Agent Orchestration](./feature-deep-dives/agent-orchestration.md)
- [Orchestrator Context Modes](./feature-deep-dives/orchestrator-context-modes.md)
- [Indexing & Languages](./feature-deep-dives/indexing-languages.md)
- [Semantic Engine](./feature-deep-dives/semantic-engine.md)
- [Semantic Embeddings Setup](./feature-deep-dives/semantic-embeddings-setup.md)
- [CLI Tool Access](./feature-deep-dives/cli-tool-access.md)
- [Development Memories](./feature-deep-dives/development-memories.md)
- [Tool Gateway](./feature-deep-dives/tool-gateway.md)
- [Code Mode](./feature-deep-dives/code-mode.md)
- [Runtime Execution](./feature-deep-dives/runtime-execution.md)
- [Token Savings Meter](./feature-deep-dives/token-savings-meter.md)

## Advanced and Supporting Docs

- [Sync Artifacts](./sync-artifacts.md)
- [Benchmark Guardrails](./benchmark-guardrails.md)
- [Benchmark Baseline Management](./benchmark-baseline-management.md)
- [Benchmark Failure Guide](./benchmark-failure-guide.md)
- [CI Memory Sync Setup](./ci-memory-sync-setup.md)
- [CI Memory Sync Operations](./ci-memory-sync.md)
- [Cross-Platform Validation](./cross-platform-validation.md)
- [Testing Guide](./testing.md)
- [Release Test Checklist](./release-test.md)
- [Plugin SDK Author Guide](./plugin-sdk-author-guide.md)
- [Plugin SDK Quick Reference](./plugin-sdk-quick-reference.md)
- [Plugin SDK Security](./plugin-sdk-security.md)

## Current Scope Snapshot

- **Version**: 0.10.2
- **Supported languages**: TS, JS, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, Shell (11 adapters, 12 languages)
- **CLI commands** (13): init, doctor, info, index, serve, export, import, pull, benchmark, summary, health, version, tool
- **MCP surfaces**:
  - Core: repo register/status/overview, index refresh, symbol search/getCard/getCards, slice build/refresh/spillover, delta get, PR risk analyze
  - Code access: getSkeleton, getHotPath, needWindow (Iris Gate Ladder)
  - Policy: get/set
  - Agent: orchestrate, feedback, feedback.query, context summary
  - Memory: store, query, remove, surface
  - Buffer: push, checkpoint, status
  - Runtime: execute, queryOutput
  - Usage: stats
  - Universal: `sdl.action.search` and `sdl.info`
  - Default flat mode: 34 tools (`32` flat tools + `sdl.action.search` + `sdl.info`)
  - Gateway-only mode: 6 tools (`4` gateway tools + `sdl.action.search` + `sdl.info`)
  - Gateway + legacy mode: 38 tools (`4` gateway + `32` legacy flat + `sdl.action.search` + `sdl.info`)
  - Code Mode (optional): adds `sdl.manual` and `sdl.chain`, or can run exclusive with `sdl.action.search`, `sdl.info`, `sdl.manual`, and `sdl.chain`
- **Semantic features**: optional semantic reranking, LLM-generated symbol summaries (Anthropic/Ollama/mock)
- **HTTP surface**: `/api/graph/*` endpoints and browser explorer at `/ui/graph` when serving over HTTP
- **Native addon**: Rust via napi-rs for multi-threaded indexing (default engine, TS fallback)
- **Runtime execution**: 16 supported runtimes (node, typescript, python, shell, ruby, php, perl, r, elixir, go, java, kotlin, rust, c, cpp, csharp)
