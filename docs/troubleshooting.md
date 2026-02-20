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
- Try the native Rust engine (`indexing.engine: "rust"`) for faster pass-1 extraction

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

### Rust Native Engine Not Loading

- Symptom: log warning "Rust engine returned null, falling back to TypeScript engine"
- Cause: the native `.node` addon was not built or is incompatible with the current Node.js version
- Resolution:
  - run `npm run build:native` from the sdl-mcp directory
  - verify the Rust toolchain is installed: `rustc --version`
  - ensure Node.js major version matches the one used during build
  - check that `native/*.node` exists after build
  - if you do not need the Rust engine, set `indexing.engine: "typescript"` (the default)

### Missing Symbols for JS Files With TS Counterparts

- Symptom: `.js` files are not indexed even though they are listed in `languages`
- Cause: when both `foo.ts` and `foo.js` exist at the same path, the scanner excludes the JS file to avoid indexing compiled output alongside source
- Resolution: this is expected behavior. If the JS file is hand-written source (not compiled), remove or rename the corresponding `.ts` file

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
