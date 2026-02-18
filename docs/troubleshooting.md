# Troubleshooting

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
  - [Troubleshooting (this page)](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

## `doctor` First

Start with:

```bash
sdl-mcp doctor --log-level debug
```

This catches most setup issues quickly.

## Common Issues

### Config Not Found

- Run `sdl-mcp init`
- Or pass explicit config path with `-c`
- Or set `SDL_CONFIG` (or `SDL_CONFIG_PATH`)
- Or set `SDL_CONFIG_HOME` to control the default global config directory

### Grammar Load Errors

- Reinstall dependencies: `npm install`
- If native modules are stale: `npm rebuild`

### Repository Not Accessible

- Verify `rootPath` exists and is readable
- Prefer absolute paths in config
- Confirm container/CI mounts include the repo

### Slow Indexing

- Reduce indexed languages to only what you need
- Add more `ignore` patterns
- Lower `maxFileBytes`
- Tune `indexing.concurrency`

### Stale Results

- Run `sdl-mcp index`
- Or call `sdl.index.refresh` with `incremental`
- Enable watcher mode if desired (`index --watch`)

### Watcher Failure Modes

If file watching is enabled by default and becomes unstable, use:

```bash
sdl-mcp serve --no-watch
```

Then run manual refreshes with `sdl-mcp index` until the underlying issue is fixed.

#### Windows: antivirus/endpoint locks

- Symptom: frequent watcher errors, delayed or missing re-index events
- Cause: file handles held by antivirus/endpoint scanning tools
- Resolution:
  - exclude your repo path and SDL-MCP DB path from scanning
  - retry with `sdl-mcp serve --no-watch` as a safe fallback

#### Linux: inotify limits

- Symptom: watcher fails to start on large repos
- Cause: low `fs.inotify.max_user_watches` / `max_user_instances`
- Resolution:
  - increase inotify limits via `sysctl`
  - reduce scope with stronger `ignore` patterns
  - cap file-watching load with `indexing.maxWatchedFiles`

#### Network drives / remote filesystems

- Symptom: inconsistent or missing watch events
- Cause: non-local filesystems may not emit reliable file notifications
- Resolution:
  - run SDL-MCP on a local clone/worktree
  - disable watch mode (`--no-watch`) and use periodic incremental indexing

### Server Starts But Agent Cannot Use Tools

- Ensure agent points to `sdl-mcp serve --stdio`
- Validate generated client config from `init --client <name>`
- Confirm process logs for startup errors on stderr

## Debug Commands

```bash
sdl-mcp version
sdl-mcp doctor --log-level debug
sdl-mcp index --repo-id <repo-id>
sdl-mcp serve --stdio
```

## Related Docs

- [Getting Started](./getting-started.md)
- [CLI Reference](./cli-reference.md)
- [Configuration Reference](./configuration-reference.md)
