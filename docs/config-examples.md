# Config Examples

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [Config Examples (this page)](./config-examples.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Tool Enforcement](./tool-enforcement.md)
  - [Troubleshooting](./troubleshooting.md)

</details>
</div>

SDL-MCP works without hand-written config for most installs. Use this page when you need copy-paste examples for config paths, repository config, agent stdio setup, HTTP transport, indexing, prefetch, or semantic summaries.

## Config File Location

You do not edit an SDL-MCP config setting to choose the config location. Set the location from the command line or environment variables.

### Per-command override

Use `--config` when one command or script step should use an explicit file path.

```powershell
sdl-mcp doctor --config "C:\sdl\global\sdlmcp.config.json"
sdl-mcp index --config "C:\sdl\global\sdlmcp.config.json"
sdl-mcp serve --stdio --config "C:\sdl\global\sdlmcp.config.json"
```

### Persistent exact file path

Use `SDL_CONFIG` when all SDL-MCP commands should use one specific file.

```powershell
$env:SDL_CONFIG = "C:\sdl\global\sdlmcp.config.json"
```

Persist the setting for future terminals:

```powershell
setx SDL_CONFIG "C:\sdl\global\sdlmcp.config.json"
sdl-mcp init --config "C:\sdl\global\sdlmcp.config.json"
```

After `setx`, open a new terminal before relying on the new value.

### Persistent directory default

Use `SDL_CONFIG_HOME` when SDL-MCP should build the file path as `<SDL_CONFIG_HOME>\sdlmcp.config.json`.

```powershell
$env:SDL_CONFIG_HOME = "C:\sdl\global"
```

Persist the setting for future terminals:

```powershell
setx SDL_CONFIG_HOME "C:\sdl\global"
```

### Config path precedence

SDL-MCP resolves config paths in this order:

1. `--config`
2. `SDL_CONFIG` or `SDL_CONFIG_PATH`
3. cwd local config at `./config/sdlmcp.config.json`, when reading an existing config
4. user-global config path, including `SDL_CONFIG_HOME` when set

For writes, `sdl-mcp init` defaults to the user-global config path unless you pass `--config`.

## Base Repository Config

This is a compact starting config for one repository.

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": ".",
      "ignore": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      "languages": [
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "go",
        "java",
        "cs",
        "c",
        "cpp",
        "php",
        "rs",
        "kt",
        "sh"
      ],
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

## Agent Stdio Configs

Stdio configs let the agent spawn the SDL-MCP server process directly. Use HTTP configs when multiple agents need to share one server.

### Codex CLI

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

### Claude Code CLI with NVM for Windows

Use `serve --stdio`. Running only `npx sdl-mcp` does not start the MCP server.

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

### Gemini CLI with NVM for Windows

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

### OpenCode CLI with NVM for Windows

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

## HTTP Transport Configs

Start the shared HTTP server first:

```bash
sdl-mcp serve --http --port 3000
```

The server prints a bearer token on startup. Pass it as `Authorization: Bearer <token>` in every MCP request unless auth is disabled.

### Static token

```json
{
  "httpAuth": {
    "enabled": true,
    "token": "my-static-token"
  }
}
```

### Session limit

```json
{
  "concurrency": {
    "maxSessions": 8
  }
}
```

### Claude Code HTTP

```json
"sdl-mcp": {
  "type": "streamableHttp",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer <token-from-server-startup>"
  }
}
```

### Cursor or generic MCP client HTTP

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

### Legacy SSE

Use this only for older MCP clients that do not support Streamable HTTP.

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

## Indexing and Retrieval

### TypeScript indexer

SDL-MCP defaults to the native Rust indexer and falls back to TypeScript automatically if the native addon is unavailable. Set the engine explicitly only when you want a pure Node.js setup.

```json
{
  "indexing": {
    "engine": "typescript"
  }
}
```

### Prefetch

Prefetch warms likely-needed results during long-running `serve` sessions.

```json
{
  "prefetch": {
    "enabled": true,
    "maxBudgetPercent": 20,
    "warmTopN": 0
  }
}
```

### Custom semantic lanes

The specialized default uses Jina for code-shaped Symbol embeddings and Nomic for prose-heavy FileSummary embeddings. Use explicit lane arrays when you want to tune one lane without changing the other.

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "symbolEmbeddingModels": ["jina-embeddings-v2-base-code"],
    "fileSummaryEmbeddingModels": ["nomic-embed-text-v1.5"]
  }
}
```

## Semantic Summary Examples

LLM summaries produce natural-language descriptions for symbols. They are optional and separate from the local embedding provider.

### Anthropic summaries

Set the key in your environment instead of committing it to a shared config.

```powershell
setx ANTHROPIC_API_KEY "sk-ant-your-key-here"
```

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "embeddingProfile": "specialized",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```

Inline keys work but are not recommended for shared configs.

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

### Ollama or OpenAI-compatible summaries

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "embeddingProfile": "specialized",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "qwen2.5-coder",
    "summaryApiBaseUrl": "http://localhost:11434/v1"
  }
}
```

Any OpenAI-compatible `/v1/chat/completions` server works.

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

### Mock summaries

Use mock summaries for testing and CI because they are deterministic and require no API calls.

```json
{
  "semantic": {
    "enabled": true,
    "generateSummaries": true,
    "summaryProvider": "mock"
  }
}
```

### Summary batch tuning

Lower concurrency for CPU-bound local models or hosted rate limits.

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

### Max-recall embeddings with hosted summaries

This runs both supported embedding models on both lanes, so indexing takes longer than the specialized default.

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "embeddingProfile": "max-recall",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```

## Verify Summaries

After indexing with summaries enabled, check a symbol card:

```text
sdl.symbol.search({ repoId: "my-repo", query: "handleRequest", limit: 1 })
sdl.symbol.getCard({ repoId: "my-repo", symbolId: "<id-from-search>" })
```

The `summary` field should contain a natural-language description. Index output also reports generated, skipped, and failed summary counts.

For the full configuration surface, see [Configuration Reference](./configuration-reference.md). For deeper semantic setup, see [Semantic Embeddings Setup](./feature-deep-dives/semantic-embeddings-setup.md) and [Semantic Engine](./feature-deep-dives/semantic-engine.md).
