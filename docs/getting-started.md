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
# Tip: If you are using npx, replace `sdl-mcp` with `npx --yes sdl-mcp@latest`.
# 1) Set config location variable then open a new terminal
setx SDL_CONFIG_HOME "C:\[your path]"

# 2) One-line non-interactive setup (init + index + doctor)
sdl-mcp init -y --auto-index --config "C:\[same path as SDL_CONFIG_HOME]"

# 3) Start MCP server (stdio for coding agents)
sdl-mcp serve --stdio

# Optional: disable watcher mode if your environment is unstable
sdl-mcp serve --stdio --no-watch

# 4) Copy the agent instructions from agent-workflows.md and paste them in the AGENTS.md file for your project.
```

What this does:

1. `init -y --auto-index` creates config, detects repo/languages, runs index, and runs doctor checks inline.
2. `serve --stdio` exposes MCP tools for coding agents.
3. `serve --no-watch` is the fallback mode when file watching is unreliable in your environment.

## Optional: Graph Explorer Over HTTP

Use HTTP transport if you want the built-in graph UI and REST endpoints.

```bash
sdl-mcp serve --http --host localhost --port 3000
```

Then open:

- `http://localhost:3000/ui/graph`
- `http://localhost:3000/api/graph/<repoId>/symbol/<symbolId>/neighborhood`
- `http://localhost:3000/api/repo/<repoId>/status`

## Optional: Native Rust Indexer

If you have a Rust toolchain installed, you can use the native Rust engine for faster pass-1 symbol extraction:

```bash
npm run build:native
```

Then set `indexing.engine` to `"rust"` in your config:

```json
{
  "indexing": {
    "engine": "rust"
  }
}
```

The Rust engine falls back to TypeScript automatically if the native addon is not available. See [Configuration Reference](./configuration-reference.md#native-rust-engine) for details.

## Optional: Enable Semantic Search and Prefetch

Add these sections to your config (or update existing values):

```json
{
  "semantic": {
    "enabled": true,
    "alpha": 0.6,
    "provider": "mock",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": false
  },
  "prefetch": {
    "enabled": true,
    "maxBudgetPercent": 20,
    "warmTopN": 50
  }
}
```

Notes:

- Set `semantic.provider` to `local` to use optional ONNX runtime (`onnxruntime-node`) for offline reranking.
- Keep `generateSummaries` disabled until you validate summary quality for your repository.
- Prefetch stats are visible in `sdl.repo.status` under `prefetchStats`.

## Config Location Control

You do not edit an SDL-MCP config setting to choose the config location. You set the location from the command line or environment variables.

### Option 1: Per-command override (`--config`)

Use `--config` when you want one command (or one script step) to use an explicit file path.

```powershell
sdl-mcp doctor --config "C:\sdl\global\sdlmcp.config.json"
sdl-mcp index --config "C:\sdl\global\sdlmcp.config.json"
sdl-mcp serve --stdio --config "C:\sdl\global\sdlmcp.config.json"
```

### Option 2: Persistent exact file path (`SDL_CONFIG`)

Use `SDL_CONFIG` when you always want SDL-MCP commands to use one specific global config file.

Current PowerShell session only:

```powershell
$env:SDL_CONFIG = "C:\sdl\global\sdlmcp.config.json"
```

Persist for future terminals:

```powershell
setx SDL_CONFIG "C:\sdl\global\sdlmcp.config.json"
# Option: initialize the global config file directly at this path
sdl-mcp init --config "C:\sdl\global\sdlmcp.config.json"
```

After `setx`, open a new terminal, then run:

```powershell
sdl-mcp doctor
```

### Option 3: Persistent directory default (`SDL_CONFIG_HOME`)

Use `SDL_CONFIG_HOME` when you want SDL-MCP to build the file path automatically as:
`<SDL_CONFIG_HOME>\sdlmcp.config.json`.

Current PowerShell session only:

```powershell
$env:SDL_CONFIG_HOME = "C:\sdl\global"
```

Persist for future terminals:

```powershell
setx SDL_CONFIG_HOME "C:\sdl\global"
```

After `setx`, open a new terminal, then run:

```powershell
sdl-mcp doctor
```

### Config Path Precedence

SDL-MCP resolves config path in this order:

1. `--config`
2. `SDL_CONFIG` (or `SDL_CONFIG_PATH`)
3. default global config path (including `SDL_CONFIG_HOME` if set)
4. legacy local fallback (`./config/sdlmcp.config.json`)

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
  "[path-to-global]/sdlmcp.config.json",
]

[mcp_servers.sdl-mcp.env]
SDL_CONFIG = "[path-to-global]/sdlmcp.config.json"
```

Claude Code CLI .json with NVM4Windows
Use `serve --stdio`; running only `npx sdl-mcp` does not start the MCP server.
```json
"sdl-mcp": {
  "type": "stdio",
  "command": "C:\\nvm4w\\nodejs\\sdl-mcp.cmd",
  "args": [
    "serve",
    "--stdio"
  ],
  "env": {
    "SDL_CONFIG": "[path-to-global]/sdlmcp.config.json"
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
    "SDL_CONFIG": "[path-to-global]/sdlmcp.config.json"
  }
}
```

OpenCode CLI .json with NVM4Windows
```json
"sdl-mcp": {
		"type": "local",
		"command": [
			"C:\\nvm4w\\nodejs\\sdl-mcp.cmd",
			"-c",
			"[path-to-global]\\sdlmcp.config.json",
			"serve",
			"--stdio"
		],
		"enabled": true
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
- VSCode extension setup: [../sdl-mcp-vscode/README.md](../sdl-mcp-vscode/README.md)
