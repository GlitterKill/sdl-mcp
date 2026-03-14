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

## Optional: Graph Explorer Over HTTP

Use HTTP transport if you want the built-in graph UI and REST endpoints.

```bash
sdl-mcp serve --http --host localhost --port 3000
```

Then open:

- `http://localhost:3000/ui/graph`
- `http://localhost:3000/api/graph/<repoId>/symbol/<symbolId>/neighborhood`
- `http://localhost:3000/api/repo/<repoId>/status`

## Optional: Switch to TypeScript Indexer

SDL-MCP ships with a native Rust indexer as the default engine. It handles pass-1 symbol extraction with multi-threaded performance. If you prefer a pure Node.js setup with zero native dependencies, you can switch to the TypeScript engine:

```json
{
  "indexing": {
    "engine": "typescript"
  }
}
```

The TypeScript engine uses tree-sitter grammars for AST parsing and works everywhere Node.js runs. It's slower than the Rust engine but has no native build requirements.

> If the Rust addon is missing at startup (e.g., unsupported platform), SDL-MCP falls back to the TypeScript engine automatically. See [Configuration Reference](./configuration-reference.md#native-rust-engine) for details.

## Optional: Enable Semantic Search and Prefetch

Add these sections to your config (or update existing values):

```json
{
  "semantic": {
    "enabled": true,
    "alpha": 0.6,
    "provider": "local",
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
