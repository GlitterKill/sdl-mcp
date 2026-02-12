# Getting Started

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started (this page)](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

## Prerequisites

- Node.js 18+
- npm
- A local repository you want to index

## Installation

### Global Install

```bash
npm install -g sdl-mcp
sdl-mcp version
```

### Run Without Installing

```bash
npx --yes sdl-mcp@latest version
```

### Install From Source

```bash
git clone <repository-url>
cd sdl-mcp
npm install
npm run build
npm link
```

## 5-Minute Setup

```bash
# from your target project directory
# If you are using npx, replace `sdl-mcp` with `npx --yes sdl-mcp@latest`.
sdl-mcp init --client codex
sdl-mcp doctor
sdl-mcp index
sdl-mcp serve --stdio
```

What this does:

1. `init` creates `config/sdlmcp.config.json` (and optional client config template)
2. `doctor` validates Node, config, DB path, grammar availability, and repo paths
3. `index` builds symbol/version/edge data into SQLite
4. `serve --stdio` exposes MCP tools for coding agents

## First Config Example

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": ".",
      "ignore": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      "languages": ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "php", "rs", "kt", "sh"],
      "maxFileBytes": 2000000
    }
  ],
  "dbPath": "./data/sdlmcp.sqlite",
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

## Sample Agent CLI Configs 
Codex CLI .toml
```toml
[mcp_servers.sdl-mcp]
command = "npx"
args = [
  "--yes",
  "sdl-mcp@latest",
  "serve",
  "--stdio",
  "--config",
  "[path-to-repo]/config/sdlmcp.config.json",
]

[mcp_servers.sdl-mcp.env]
SDL_CONFIG = "[path-to-repo]/config/sdlmcp.config.json"
```

Claude Code CLI .json with NVM4Windows
```json
"sdl-mcp": {
  "type": "stdio",
  "command": "C:\\nvm4w\\nodejs\\sdl-mcp.cmd",
  "args": [
    "serve",
    "--stdio"
  ],
  "env": {
    "SDL_CONFIG": "[path-to-repo]/config/sdlmcp.config.json"
  }
 }
```

Gemini CLI .json with NVM4Windows
```json
"sdl-mcp": {
  "type": "stdio",
  "command": "C:\\nvm4w\\nodejs\\sdl-mcp.cmd",
  "args": [
    "serve",
    "--stdio"
  ],
  "env": {
    "SDL_CONFIG": "[path-to-repo]/config/sdlmcp.config.json"
  }
}
```

## Basic Agent Verification

After server startup, verify your agent/tooling can call:

1. `sdl.repo.register`
2. `sdl.index.refresh`
3. `sdl.symbol.search`
4. `sdl.symbol.getCard`

If those work, you are ready for slice and code-window workflows.

## Next Steps

- Command details: [CLI Reference](./cli-reference.md)
- Tool payloads: [MCP Tools Reference](./mcp-tools-reference.md)
- Config tuning: [Configuration Reference](./configuration-reference.md)
