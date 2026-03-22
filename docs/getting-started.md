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

</details>
</div>

## Prerequisites

- Node.js 20+
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

## Optional but Highly Recommended: Tool Enforcement

Tool enforcement is optional, but it is the recommended way to make sure agents actually use SDL-MCP and realize the token savings.

Without enforcement, a client can have SDL-MCP connected and still waste tokens on native read and shell tools.

Generate an SDL-first setup for your client:

```bash
sdl-mcp init --client claude-code --enforce-agent-tools
# or: codex, gemini, opencode
```

This enables SDL runtime and exclusive Code Mode, then generates the repo-local instruction files and client-specific enforcement assets for the chosen client.

See [Tool Enforcement](./tool-enforcement.md) for the cross-client guide and [Claude-specific enforcement](./tool-enforcement-for-claude.md) for the Claude details.

## Optional: Streamable HTTP Transport (Multi-Agent)

By default, `sdl-mcp serve --stdio` runs a single MCP session over standard I/O — one agent, one connection. **Streamable HTTP** mode exposes the same MCP tools over HTTP, enabling multiple agents to connect concurrently with full session isolation.

### When to Use HTTP vs Stdio

| | Stdio | Streamable HTTP |
|:--|:------|:----------------|
| **Connections** | 1 agent | Up to 8 concurrent agents (configurable) |
| **Setup** | Zero config — agent spawns the process | Start server first, then point agents at the URL |
| **Session isolation** | N/A (single session) | Each connection gets its own MCP session |
| **Reconnect support** | None (process dies = session lost) | Built-in event store for resumable sessions |
| **Graph UI + REST API** | Not available | Available at `/ui/graph` and `/api/*` |
| **Best for** | Single-agent workflows, simple setups | Multi-agent teams, shared dev servers, CI pipelines |

### Starting the HTTP Server

```bash
# Basic (localhost:3000)
sdl-mcp serve --http

# Custom host and port
sdl-mcp serve --http --host 0.0.0.0 --port 8080

# With explicit config
sdl-mcp serve --http --port 3000 --config "C:\sdl\global\sdlmcp.config.json"

# Disable file watcher (if your environment has issues with it)
sdl-mcp serve --http --port 3000 --no-watch
```

On startup, the server prints a **bearer token** to stderr:

```
[sdl-mcp] HTTP server listening on http://localhost:3000
[sdl-mcp] HTTP auth token: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

Copy this token — agents must include it as `Authorization: Bearer <token>` in every request.

You can also set a **static token** or **disable auth entirely** via config:

```json
{
  "httpAuth": {
    "enabled": true,
    "token": "my-static-token"
  }
}
```

Set `"enabled": false` to disable auth for trusted local environments. See [Configuration Reference → httpAuth](./configuration-reference.md#httpauth-optional) for details.

### Endpoints

| Endpoint | Method | Purpose |
|:---------|:-------|:--------|
| `/mcp` | POST | Streamable HTTP MCP calls (primary) |
| `/mcp` | GET | Server-sent events for push notifications |
| `/mcp` | DELETE | Terminate an MCP session |
| `/sse` | GET | Legacy SSE transport (deprecated) |
| `/message` | POST | Legacy SSE message endpoint (deprecated) |
| `/health` | GET | Health check (no auth required) |
| `/ui/graph` | GET | Interactive graph explorer |
| `/api/*` | GET | REST API for graph queries |

### Session Management

Each HTTP connection creates an isolated MCP session. Configure limits in your `sdlmcp.config.json`:

```json
{
  "concurrency": {
    "maxSessions": 8
  }
}
```

Sessions are automatically reaped after 5 minutes of idle time. The server supports up to 8 concurrent sessions by default — each session has its own tool dispatch context, so agents don't interfere with each other.

### Agent Configs for HTTP Transport

**Claude Code** (`.claude/settings.json` or project MCP config):

```json
"sdl-mcp": {
  "type": "streamableHttp",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer <token-from-server-startup>"
  }
}
```

**Cursor / Generic MCP client:**

```json
{
  "mcpServers": {
    "sdl-mcp": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-server-startup>"
      }
    }
  }
}
```

**Legacy SSE transport** (for older MCP clients that don't support streamable HTTP):

```json
{
  "mcpServers": {
    "sdl-mcp": {
      "transport": "sse",
      "url": "http://localhost:3000/sse",
      "headers": {
        "Authorization": "Bearer <token-from-server-startup>"
      }
    }
  }
}
```

### Multi-Agent Example

A typical multi-agent setup: start one SDL-MCP server and connect multiple coding agents.

```bash
# Terminal 1: Start the shared server
sdl-mcp serve --http --port 3000

# Terminal 2: Agent A connects (e.g., Claude Code with HTTP config above)
# Terminal 3: Agent B connects (e.g., Cursor with HTTP config above)
# Terminal 4: Agent C connects (e.g., CI pipeline calling MCP tools via curl)
```

Each agent gets its own session. If Agent A is building slices for the auth module while Agent B explores the database layer, their operations are fully isolated.

### Graph Explorer

The HTTP server includes a built-in graph visualization UI:

- `http://localhost:3000/ui/graph` — interactive symbol graph explorer
- `http://localhost:3000/api/graph/<repoId>/symbol/<symbolId>/neighborhood` — symbol neighborhood API
- `http://localhost:3000/api/repo/<repoId>/status` — repository status API

## Optional: Switch to TypeScript Indexer

SDL-MCP defaults to the native Rust indexer for pass-1 symbol extraction with multi-threaded performance. If the Rust addon is missing at startup (e.g., unsupported platform), SDL-MCP falls back to the TypeScript engine automatically.

If you prefer a pure Node.js setup with zero native dependencies, you can explicitly switch to the TypeScript engine:

```json
{
  "indexing": {
    "engine": "typescript"
  }
}
```

The TypeScript engine uses tree-sitter grammars for AST parsing and works everywhere Node.js runs. It's slower than the Rust engine but has no native build requirements.

See [Configuration Reference](./configuration-reference.md#native-rust-engine) for details.

## Optional: Enable Prefetch

Semantic search is enabled by default with the `local` ONNX embedding provider. To also enable predictive background warming of likely-needed results:

```json
{
  "prefetch": {
    "enabled": true,
    "maxBudgetPercent": 20,
    "warmTopN": 50
  }
}
```

Notes:

- Semantic search (`semantic.enabled`) is `true` by default with `provider: "local"` using ONNX runtime.
- Keep `generateSummaries` disabled until you validate summary quality for your repository.
- Prefetch is disabled by default; enable it for long-running `serve` sessions to pre-warm results.
- Prefetch stats are visible in `sdl.repo.status` under `prefetchStats`.

## Optional: Enable LLM-Generated Summaries

LLM summaries produce 1–3 sentence natural-language descriptions for every symbol in your repository. These summaries appear in symbol cards and significantly improve semantic search quality.

### How It Works

The summary system has **three quality tiers**. Each tier builds on the previous one:

```
Tier     Embedding Model              Summaries    Search Quality   Cost
─────    ───────────────────────────  ───────────  ───────────────  ────────
Low      all-MiniLM-L6-v2 (384d)     None         Baseline         Free
Medium   nomic-embed-text-v1.5 (768d) None         Better           Free
High     either model                 LLM-gen'd    Best             API cost
```

- **Low** (default) — embeds raw symbol text (name + kind + signature) with a general-purpose model. No API calls needed.
- **Medium** — swaps in a higher-quality text embedding model with longer context (8192 tokens) for better semantic matching. Still fully offline (~138 MB download).
- **High** — adds LLM-generated natural-language summaries to either embedding model. Both models are text-based and benefit equally from summaries. This produces the best search results because the LLM distills code meaning into plain English that embedding models handle well.

To reach the **High** tier, you enable `generateSummaries` and configure one of the three summary providers below.

### Three Summary Providers

Summary generation is independent from the embedding provider. You can mix and match — for example, use local embeddings but Anthropic for summaries.

| Provider | `summaryProvider` | Best for | Cost |
|:---------|:-------------------|:---------|:-----|
| **Anthropic API** | `"api"` | Highest quality, no local GPU needed | ~$0.25/1M input tokens (Haiku) |
| **Ollama / OpenAI-compatible** | `"local"` | Free, private, runs on your machine | Free (your hardware) |
| **Mock** | `"mock"` | Testing and CI pipelines | Free (deterministic heuristics) |

---

### Provider 1: Anthropic API

Uses Claude models via the Anthropic Messages API. This is the highest-quality option and requires no local GPU.

**Get an API key:**
1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Go to **API Keys** and create a new key
3. Copy the key (starts with `sk-ant-`)

**Recommended models:**

| Model | Speed | Quality | Pricing (input / output) |
|:------|:------|:--------|:-------------------------|
| `claude-haiku-4-5-20251001` | Fast | Good (default) | $0.25 / $1.25 per 1M tokens |
| `claude-sonnet-4-20250514` | Medium | Higher | $3 / $15 per 1M tokens |

For most repositories, Haiku is the best balance of cost and quality. Each symbol uses roughly 50–150 input tokens.

**Configuration (environment variable for key):**

```bash
# Set once — persists across terminals
setx ANTHROPIC_API_KEY "sk-ant-your-key-here"
```

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```

**Configuration (key inline — not recommended for shared configs):**

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001",
    "summaryApiKey": "sk-ant-your-key-here"
  }
}
```

> **Key resolution order:** `summaryApiKey` in config → `ANTHROPIC_API_KEY` environment variable. If neither is set, summary generation is skipped and a warning is logged. Existing cached summaries are preserved.

---

### Provider 2: Ollama (OpenAI-Compatible)

Uses any model served via an OpenAI-compatible `/v1/chat/completions` endpoint. [Ollama](https://ollama.com) is the easiest way to run models locally for free.

**Install Ollama and pull a model:**

```bash
# 1. Install Ollama from https://ollama.com/download
#    Windows: winget install Ollama.Ollama
#    macOS:   brew install ollama
#    Linux:   curl -fsSL https://ollama.com/install.sh | sh

# 2. Start the Ollama server (runs on port 11434 by default)
ollama serve

# 3. Pull a model — pick one:
ollama pull llama3.2          # 3B params, fast, low RAM (~2 GB)
ollama pull llama3.1          # 8B params, good balance (~5 GB)
ollama pull qwen2.5-coder     # 7B params, code-focused (~4.5 GB)
ollama pull mistral            # 7B params, general-purpose (~4 GB)
ollama pull deepseek-coder-v2  # 16B params, best code quality (~9 GB)
```

**Recommended Ollama models for code summaries:**

| Model | Size | RAM needed | Quality | Notes |
|:------|:-----|:-----------|:--------|:------|
| `llama3.2` | 3B | ~2 GB | Good | Fastest, fine for simple codebases |
| `qwen2.5-coder` | 7B | ~4.5 GB | Better | Trained on code, understands patterns well |
| `llama3.1` | 8B | ~5 GB | Better | Strong general-purpose reasoning |
| `deepseek-coder-v2` | 16B | ~9 GB | Best | Best code understanding, needs more RAM |

**Configuration:**

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "qwen2.5-coder",
    "summaryApiBaseUrl": "http://localhost:11434/v1"
  }
}
```

> The default base URL is already `http://localhost:11434/v1` (Ollama's default), so you can omit `summaryApiBaseUrl` if Ollama is running on the same machine with default settings.

**Using other OpenAI-compatible servers:**

Any server that implements the `/v1/chat/completions` endpoint works. Examples:

| Server | Base URL | Notes |
|:-------|:---------|:------|
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | Default, no auth needed |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | GUI-based, easy model management |
| [vLLM](https://docs.vllm.ai) | `http://localhost:8000/v1` | High-throughput production serving |
| [LocalAI](https://localai.io) | `http://localhost:8080/v1` | Drop-in OpenAI replacement |
| OpenAI API | `https://api.openai.com/v1` | Set `summaryApiKey` to your OpenAI key |

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "your-model-name",
    "summaryApiBaseUrl": "http://your-server:port/v1",
    "summaryApiKey": "your-key-if-needed"
  }
}
```

---

### Provider 3: Mock

Generates deterministic heuristic summaries without any API calls. Useful for testing your config or running in CI.

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "mock"
  }
}
```

---

### Tuning Batch Processing

Summary generation processes symbols in parallel batches. Adjust these settings based on your provider's rate limits and your hardware:

| Setting | Default | Range | Description |
|:--------|:--------|:------|:------------|
| `summaryBatchSize` | 20 | 1–50 | Symbols processed per batch |
| `summaryMaxConcurrency` | 5 | 1–20 | Batches running in parallel |

**For Anthropic API** — defaults are fine. Lower `summaryMaxConcurrency` to `3` if you hit rate limits on a free-tier key.

**For Ollama on CPU** — set `summaryMaxConcurrency` to `1` and `summaryBatchSize` to `10` to avoid overwhelming your machine.

**For Ollama on GPU** — defaults are fine. Increase `summaryMaxConcurrency` to `8–10` if your GPU has headroom.

```json
{
  "semantic": {
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "qwen2.5-coder",
    "summaryMaxConcurrency": 1,
    "summaryBatchSize": 10
  }
}
```

### Verifying Summaries

After indexing with summaries enabled, check that they're appearing in symbol cards:

```
sdl.symbol.search({ repoId: "my-repo", query: "handleRequest", limit: 1 })
sdl.symbol.getCard({ repoId: "my-repo", symbolId: "<id-from-search>" })
```

The card's `summary` field should contain a natural-language description instead of a heuristic placeholder. You can also check batch results in the index output — it reports how many summaries were generated, skipped (cached), and failed.

### Quick Reference: Copy-Paste Configs

**Anthropic Haiku (recommended for most users):**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```
Requires: `ANTHROPIC_API_KEY` environment variable.

**Ollama local (free, private):**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "qwen2.5-coder"
  }
}
```
Requires: Ollama running with `qwen2.5-coder` pulled.

**Nomic embeddings + Anthropic summaries (highest quality):**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "nomic-embed-text-v1.5",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```
Requires: `ANTHROPIC_API_KEY` environment variable. Downloads ~138 MB embedding model on first run.

For the full configuration reference, see [Configuration Reference](./configuration-reference.md). For a deeper look at how summaries interact with embeddings and pass-2 resolution, see [Semantic Engine](./feature-deep-dives/semantic-engine.md).

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
  "graphDatabase": { "path": "./data/sdl-mcp-graph.lbug" },
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

## Sample Agent CLI Configs (Stdio)

These configs use stdio transport — the agent spawns the SDL-MCP process directly. For HTTP transport configs (multi-agent), see [Streamable HTTP Transport](#optional-streamable-http-transport-multi-agent) above.

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
