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

1. `init` creates `sdlmcp.config.json` at the active global config location by default (and optional client config template). You can set the target path explicitly during setup with `sdl-mcp init --config "C:\sdl\global\sdlmcp.config.json"`.
2. `doctor` validates Node, config, DB path, grammar availability, and repo paths.
3. `index` builds symbol/version/edge data into SQLite
4. `serve --stdio` exposes MCP tools for coding agents

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
