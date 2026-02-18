# Documentation Hub

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub (this page)](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Use this page as the entry point for SDL-MCP documentation.

## Read By Goal

- I want to install and run SDL-MCP quickly:
  - [Getting Started](./getting-started.md)
- I need command syntax and examples:
  - [CLI Reference](./cli-reference.md)
- I need MCP tool payloads and responses:
  - [MCP Tools Reference](./mcp-tools-reference.md)
- I need to tune repository, policy, and slice behavior:
  - [Configuration Reference](./configuration-reference.md)
- I want agent best practices and context-ladder workflows:
  - [Agent Workflows](./agent-workflows.md)
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
- MCP tools include repository overview, context summary, PR risk analysis, and agent orchestration
- Semantic and summary features: optional semantic reranking and generated symbol summaries (feature-flagged)
- HTTP graph surface: `/api/graph/*` endpoints and browser explorer at `/ui/graph` when serving over HTTP
- VSCode extension MVP: see `../sdl-mcp-vscode/README.md`
