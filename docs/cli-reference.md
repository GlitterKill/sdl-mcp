# CLI Reference

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference (this page)](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

## Run Without Installing (npx)

If you do not want a global install, run commands through `npx`:

```bash
npx --yes sdl-mcp@latest version
npx --yes sdl-mcp@latest doctor
```

In this document, replace `sdl-mcp` with `npx --yes sdl-mcp@latest` if you use `npx`.

## Global Options

- `-c, --config <PATH>` (explicit config file path)
- `--log-level <debug|info|warn|error>` (default: `info`)
- `--log-format <json|pretty>` (default: `pretty`)
- `-h, --help`
- `-v, --version`

Config lookup order when `--config` is omitted:

1. `SDL_CONFIG` (or `SDL_CONFIG_PATH`)
2. Local config in current working directory (`./config/sdlmcp.config.json`)
3. Global config path (default user-level location; overridable via `SDL_CONFIG_HOME`)
4. Package-local fallback (`<sdl-mcp package root>/config/sdlmcp.config.json`)

## Commands

### `sdl-mcp init`

Initialize configuration and optional client template.

```bash
sdl-mcp init --client codex --repo-path . --languages ts,py,go
```

Key options:

- `--client <claude-code|codex|gemini|opencode>`
- `--repo-path <PATH>` (default: current directory)
- `--languages <comma-separated>` (default: all supported languages)
- `-f, --force`

### `sdl-mcp doctor`

Validate runtime and environment.

```bash
sdl-mcp doctor --log-level info
```

Checks include Node version, config readability, DB writability, grammar availability, and repo path accessibility.

### `sdl-mcp index`

Index configured repository data into the ledger.

```bash
sdl-mcp index --repo-id my-repo
sdl-mcp index --watch
```

Key options:

- `--repo-id <ID>`
- `-w, --watch`

### `sdl-mcp serve`

Start the MCP server.

```bash
sdl-mcp serve --stdio
sdl-mcp serve --http --host localhost --port 3000
```

Key options:

- `--stdio`
- `--http`
- `--host <HOST>` (default: `localhost`)
- `--port <NUMBER>` (default: `3000`)

### `sdl-mcp export`

Export a sync artifact.

```bash
sdl-mcp export --repo-id my-repo --output .sdl-sync
sdl-mcp export --list
```

Key options:

- `--repo-id <ID>`
- `--version-id <ID>`
- `--commit-sha <SHA>`
- `--branch <NAME>`
- `-o, --output <PATH>` (default: `.sdl-sync/`)
- `--list`

### `sdl-mcp import`

Import a sync artifact.

```bash
sdl-mcp import --artifact-path .sdl-sync/my-repo.sdl-artifact.json --repo-id my-repo
```

Key options:

- `--artifact-path <PATH>`
- `--repo-id <ID>`
- `-f, --force`
- `--verify` (default: `true`)

### `sdl-mcp pull`

Pull by artifact selection rules, with optional fallback.

```bash
sdl-mcp pull --repo-id my-repo --commit-sha a1b2c3d --fallback --retries 3
```

Key options:

- `--repo-id <ID>`
- `--version-id <ID>`
- `--commit-sha <SHA>`
- `--fallback` (default: `true`)
- `--retries <NUMBER>` (default: `3`)

### `sdl-mcp benchmark:ci`

Run benchmark checks in CI.

```bash
sdl-mcp benchmark:ci --repo-id my-repo --update-baseline
```

Key options:

- `--repo-id <ID>`
- `--baseline-path <PATH>` (default: `.benchmark/baseline.json`)
- `--threshold-path <PATH>` (default: `config/benchmark.config.json`)
- `--out <PATH>` (default: `.benchmark/latest.json`)
- `--json`
- `--update-baseline`
- `--skip-indexing`

### `sdl-mcp version`

Print version and environment.

```bash
sdl-mcp version
```

## Typical Flows

### Local Setup

```bash
sdl-mcp init --client codex
sdl-mcp doctor
sdl-mcp index
sdl-mcp serve --stdio
```

### CI Data Sync

```bash
sdl-mcp export --repo-id my-repo --commit-sha $GIT_SHA
sdl-mcp pull --repo-id my-repo --commit-sha $GIT_SHA --fallback
sdl-mcp benchmark:ci --repo-id my-repo
```
