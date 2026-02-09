# SDL-MCP User Guide

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide (this page)](./USER_GUIDE.md)

</details>
</div>

This guide is now a compatibility entry point.

For current, modular documentation, use:

- [Documentation Hub](./README.md)
- [Getting Started](./getting-started.md)
- [CLI Reference](./cli-reference.md)
- [MCP Tools Reference](./mcp-tools-reference.md)
- [Configuration Reference](./configuration-reference.md)
- [Agent Workflows](./agent-workflows.md)
- [Troubleshooting](./troubleshooting.md)

## What SDL-MCP Provides

- Symbol-card-first context retrieval for coding agents
- Graph slices with token-aware budgets
- Policy-gated code-window access
- Delta and PR risk tooling for change analysis
- Multi-language indexing and repository overview support

## Recommended Workflow

1. Install and initialize: `sdl-mcp init`
2. Validate setup: `sdl-mcp doctor`
3. Index repositories: `sdl-mcp index`
4. Start MCP server: `sdl-mcp serve --stdio`
5. Use tools in ladder order (search -> card -> slice -> skeleton -> hot-path -> window)
