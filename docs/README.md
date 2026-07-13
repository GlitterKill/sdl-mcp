# Documentation Hub

Use this page to choose the shortest path to the SDL-MCP documentation you need.

## Start and connect

- [Getting Started](./getting-started.md): install SDL-MCP, initialize a repository, and connect an MCP client.
- [CLI Reference](./cli-reference.md): command syntax and CLI behavior.
- [Tool Enforcement](./tool-enforcement.md): generate an SDL-first setup for Claude, Codex, Gemini, or OpenCode.
- [Claude-specific enforcement](./tool-enforcement-for-claude.md): Claude hooks and generated assets.

## Use SDL-MCP

- [MCP Tools Reference](./mcp-tools-reference.md): canonical MCP request, response, and workflow guidance.
- [Generated Tool Inventory](./generated/tool-inventory.md): current registered tools and mode counts.
- [Code Mode](./feature-deep-dives/code-mode.md): compact discovery, retrieval, file, and workflow surfaces.
- [Agent Workflows](./agent-workflows.md): practical retrieval and editing workflows.
- [CLI Tool Access](./feature-deep-dives/cli-tool-access.md): direct action aliases, output formats, and scripting guidance.

- [File Read](./file-read-tool.md), [File Write](./file-write-tool.md), [Search Edit](./search-edit-tool.md), and [Symbol Edit](./symbol-edit-tool.md): safe file and source-edit operations.
- [Iris Gate Ladder](./feature-deep-dives/iris-gate-ladder.md): the context escalation model.
- [Prompt Cache Hygiene](./prompt-cache-hygiene.md): stability rules for cache-friendly tool surfaces.

## Configure and operate

- [Configuration Reference](./configuration-reference.md) and [Configuration Examples](./config-examples.md): settings, defaults, and working configurations.
- [Runtime Execution](./feature-deep-dives/runtime-execution.md): governed repository commands and persisted output.
- [Observability Dashboard](./feature-deep-dives/observability-dashboard.md): operational metrics and the HTTP dashboard.
- [Graph Viewer](./feature-deep-dives/graph-viewer.md): SDL Galaxy and graph-viewer endpoints.
- [Troubleshooting](./troubleshooting.md): common setup and runtime failures.
- [Testing Guide](./testing.md), [Cross-Platform Validation](./cross-platform-validation.md), and [Release Test Checklist](./release-test.md): verification and release work.
- [Benchmark Guardrails](./benchmark-guardrails.md), [Benchmark Baseline Management](./benchmark-baseline-management.md), and [Benchmark Failure Guide](./benchmark-failure-guide.md): performance regression work.
- [Sync Artifacts](./sync-artifacts.md), [CI Memory Sync Setup](./ci-memory-sync-setup.md), and [CI Memory Sync Operations](./ci-memory-sync.md): shared and automated repository state.

## Understand features

### Retrieval and context

- [Graph Slicing](./feature-deep-dives/graph-slicing.md)
- [Agent Context](./feature-deep-dives/agent-context.md)
- [Context Modes](./feature-deep-dives/context-modes.md)
- [Delta and Blast Radius](./feature-deep-dives/delta-blast-radius.md)
- [Live Indexing](./feature-deep-dives/live-indexing.md)
- [Governance and Policy](./feature-deep-dives/governance-policy.md)
- [Token Economy](./feature-deep-dives/token-economy.md)
- [Token Savings Meter](./feature-deep-dives/token-savings-meter.md)

### Indexing and semantic precision

- [Indexing and Languages](./feature-deep-dives/indexing-languages.md)
- [Language Provider Support](./feature-deep-dives/language-provider-support.md)
- [Provider-First Indexing](./feature-deep-dives/provider-first-indexing.md)
- [SCIP Integration](./feature-deep-dives/scip-integration.md)
- [Semantic Engine](./feature-deep-dives/semantic-engine.md)
- [Semantic Embeddings Setup](./feature-deep-dives/semantic-embeddings-setup.md)
- [Semantic Enrichment Bridge](./feature-deep-dives/semantic-enrichment-bridge.md)

### Platform features

- [Development Memories](./feature-deep-dives/development-memories.md)
- [Memory Protocol](./memory-protocol.md): opt-in memory behavior and storage rules.
- [Tool Gateway](./feature-deep-dives/tool-gateway.md)
- [Visual Configuration Admin Console](./feature-deep-dives/config-admin-console.md)

## Extend SDL-MCP

- [Architecture](./architecture.md): components, data flow, and implementation boundaries.
- [Plugin SDK Author Guide](./plugin-sdk-author-guide.md)
- [Plugin SDK Quick Reference](./plugin-sdk-quick-reference.md)
- [Plugin SDK Security](./plugin-sdk-security.md)
- [Canonical Extractor Contract](./canonical-extractor-contract.md)

## Current interfaces

The project release defines the installed version. Run `sdl-mcp version` to inspect it.

The [Generated Tool Inventory](./generated/tool-inventory.md) is the source of truth for registered MCP tools and mode counts. Use the [MCP Tools Reference](./mcp-tools-reference.md) for request and response guidance.

The direct CLI `tool` command exposes its documented action aliases. Code Mode wrappers such as `sdl.context`, `sdl.retrieve`, `sdl.workflow`, and `sdl.file` remain MCP-only.
