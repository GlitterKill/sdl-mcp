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

</details>
</div>

## `info` Then `doctor`

Start with:

```bash
sdl-mcp info
```

This shows the resolved config path, active log file, log fallback status, Ladybug availability, and native-addon state in one place.

Then run:

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

### After Upgrading SDL-MCP

If you see errors that say a database is "not compatible with the current graph engine," delete the existing `.lbug` database directory and re-run indexing. Migrating older graph databases in-place is not supported.

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
- Use `sdl-mcp info` to confirm the resolved config path, log file path, and native-addon status
- Confirm process logs in the configured log file; enable `SDL_CONSOLE_LOGGING=true` if you want stderr mirroring during manual debugging

### Log File Missing or Unexpected

- Symptom: no logs in the configured location, or logs appear under a temp directory
- Cause: `SDL_LOG_FILE` or the derived default path is not writable
- Resolution:
  - run `sdl-mcp info` and inspect `logging.path` and `logging.fallbackUsed`
  - fix permissions or choose a writable `SDL_LOG_FILE`
  - set `SDL_CONSOLE_LOGGING=true` temporarily if you need stderr mirroring while fixing file logging

### LadybugDB Issues

#### Lock file prevents startup

- Symptom: error about database lock or "directory in use" on startup
- Cause: a previous SDL-MCP process crashed without releasing the lock, or another process has the DB open
- Resolution:
  - ensure no other `sdl-mcp serve` or `sdl-mcp index` process is running
  - delete the lock file inside the `.lbug` database directory (the directory named in your `graphDatabase.path` config), then restart
  - if the database is corrupted, delete the entire `.lbug` directory and re-run `sdl-mcp index`

#### Concurrent access errors

- Symptom: intermittent query failures or "transaction conflict" errors when multiple agents connect
- Cause: LadybugDB allows concurrent reads but serializes writes; long-running write transactions can conflict
- Resolution:
  - use HTTP transport (`serve --http`) for multi-agent setups — sessions are isolated
  - avoid running `sdl-mcp index` while agents are actively querying; index during quiet periods or use incremental mode
  - if errors persist, restart the server to clear stale transaction state

#### Database incompatible after upgrade

- Symptom: error "not compatible with the current graph engine" on startup
- Cause: LadybugDB schema version changed between SDL-MCP releases; in-place migration is not supported
- Resolution: delete the `.lbug` database directory and re-run `sdl-mcp index` to rebuild from source

### Semantic / Embedding Setup Issues

#### ONNX Runtime not loading

- Symptom: warning "Failed to load ONNX runtime" or semantic search returns no results
- Cause: `onnxruntime-node` native binary is missing or incompatible with the current platform/Node.js version
- Resolution:
  - run `npm rebuild onnxruntime-node` to recompile for your platform
  - on Windows, ensure the Visual C++ Redistributable is installed
  - if the ONNX binary cannot be built, set `semantic.enabled: false` in config to disable semantic features and fall back to text-based search
  - check `sdl-mcp doctor` output for ONNX-specific diagnostics

#### Embedding model download fails

- Symptom: first-run hangs or errors during model download (e.g., `nomic-embed-text-v1.5`)
- Cause: network restrictions or proxy settings blocking the model download (~138 MB)
- Resolution:
  - ensure outbound HTTPS access to Hugging Face model hub
  - configure proxy via `HTTPS_PROXY` environment variable if needed
  - use the smaller default model (`all-MiniLM-L6-v2`) which may already be cached

## Debug Commands

```bash
sdl-mcp version
sdl-mcp info
sdl-mcp doctor --log-level debug
sdl-mcp index --repo-id <repo-id>
sdl-mcp serve --stdio
```

## Related Docs

- [Getting Started](./getting-started.md)
- [CLI Reference](./cli-reference.md)
- [Configuration Reference](./configuration-reference.md)
