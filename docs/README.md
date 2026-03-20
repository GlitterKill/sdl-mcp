# Documentation Hub

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub (this page)](./README.md)
  - [Iris Gate Ladder](./IRIS_GATE_LADDER.md)
  - [Architecture](./ARCHITECTURE.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Tool Enforcement](./tool-enforcement.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Use this page as the entry point for SDL-MCP documentation.

## Read By Goal

- I want to understand the technical stack and data flow:
  - [Architecture](./ARCHITECTURE.md)
- I want to install and run SDL-MCP quickly:
  - [Getting Started](./getting-started.md)
- I need command syntax and examples:
  - [CLI Reference](./cli-reference.md)
- I need MCP tool payloads and responses:
  - [MCP Tools Reference](./mcp-tools-reference.md)
- I need to tune repository, policy, and slice behavior:
  - [Configuration Reference](./configuration-reference.md)
- I want agent best practices and Iris Gate Ladder workflows:
  - [Agent Workflows](./agent-workflows.md)
  - [Iris Gate Ladder](./IRIS_GATE_LADDER.md)
- I want agents to actually use SDL-MCP instead of native token-heavy tools:
  - [Tool Enforcement](./tool-enforcement.md)
  - [Claude-Specific Enforcement](./tool-enforcement-for-claude.md)
- I need operational debugging guidance:
  - [Troubleshooting](./troubleshooting.md)

## Advanced and Supporting Docs

- [Sync Artifacts](./sync-artifacts.md)
- [Benchmark Guardrails](./benchmark-guardrails.md)
- [Benchmark Baseline Management](./benchmark-baseline-management.md)
- [Benchmark Failure Guide](./benchmark-failure-guide.md)
- [CI Memory Sync Setup](./CI_MEMORY_SYNC_SETUP.md)
- [CI Memory Sync Operations](./CI_MEMORY_SYNC.md)
- [Testing Guide](./TESTING.md)
- [Release Test Checklist](./RELEASETEST.md)
- [Plugin SDK Author Guide](./PLUGIN_SDK_AUTHOR_GUIDE.md)
- [Plugin SDK Quick Reference](./PLUGIN_SDK_QUICK_REFERENCE.md)
- [Plugin SDK Implementation](./PLUGIN_SDK_IMPLEMENTATION.md)
- [Plugin SDK Security](./PLUGIN_SDK_SECURITY.md)
- [VSCode Extension README](../sdl-mcp-vscode/README.md)

## Current Scope Snapshot

- Supported languages: TS, JS, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, Shell
- CLI: init, doctor, index, serve, export, import, pull, benchmark:ci, summary, health, version
- MCP tools (19 total): repository overview, symbol search and batch card fetch, graph slice workflows, delta and PR risk analysis, code access ladder, context summary, agent orchestration, and agent feedback recording/query
- Semantic and summary features: optional semantic reranking and generated symbol summaries (feature-flagged)
- HTTP graph surface: `/api/graph/*` endpoints and browser explorer at `/ui/graph` when serving over HTTP
- VSCode extension MVP: see `../sdl-mcp-vscode/README.md`
