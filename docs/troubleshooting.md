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

### Indexing Runs Out of Heap

Large TypeScript/JavaScript monorepos can still exhaust V8's default heap when
the TypeScript pass-2 resolver builds a full compiler program. SDL-MCP keeps
that compiler program out of pass-1 parsing, but pass 2 still needs memory
proportional to the selected TS/JS files plus any included type declarations.

- Set `includeNodeModulesTypes: false` unless `@types/*` declarations are
  important for call-resolution quality in that repo.
- Lower `indexing.concurrency` and `indexing.pass2Concurrency` to reduce peak
  overlap with queued database writes.
- Raise the Node heap for very large repos, for example
  `NODE_OPTIONS=--max-old-space-size=8192 sdl-mcp index`.

On Windows, SDL-MCP defaults legacy pass-1 indexing to stable DB writes because
overlapping parser work with background LadybugDB batch commits can terminate
Node with a native access violation. This is safer but slower. For controlled
benchmarking only, set `SDL_MCP_PASS1_STABLE_DB_WRITES=0` to restore overlapped
writes; if the crash returns, leave the default in place.

If the CLI appears to spend most of its time at `Flushing pass 1 writes`, run a
diagnostic index against a temporary graph DB so production state is untouched:

```powershell
$profileDir = Join-Path $PWD ".tmp\pass1-drain-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$env:SDL_GRAPH_DB_PATH = Join-Path $profileDir "sdl-mcp-graph.lbug"
npx tsx scripts/index-repo.ts <repo-id> --mode full --config <config-path> --diagnostics --quiet-progress
Remove-Item Env:SDL_GRAPH_DB_PATH
```

The timing output includes `pass1Drain`, nested `pass1Drain.write.*` totals, and
a `Pass 1 Write Drain` row-count summary. Use the largest timings to separate
stale symbol deletion, file upsert, symbol reference insert, symbol upsert, and
`DEPENDS_ON` edge insert costs.

If provider-first indexing pauses after `Symbol Embeddings` reaches 100%, that
progress tick marks completed inference, not the end of persistence. With
`--diagnostics`, compare the wall-clock `.inference`, `.persistence.flush`,
`.persistence.finalFlush`, `.hnsw.drop`, `.hnsw.create`, `.checkpoint.pre`, and
`.checkpoint.post` subphases under
`semanticReadiness.symbolEmbeddings:<model>` to identify the remaining work.

### Indexing or Tool Queue Timeouts

Start by checking the server log named by `sdl-mcp info`. The two timeout
families have different effects and different controls.

- `derived-refresh timed out after ...` means background startup recovery for
  stale graph-derived state exceeded `SDL_DERIVED_REFRESH_TIMEOUT_MS` (default
  `120000`). The queue owns cluster, process, and algorithm refreshes only;
  semantic summaries and embeddings stay as separate readiness work. The worker
  aborts the refresh signal, records `derivedState.lastError`, leaves graph
  derived state stale until a later successful refresh, and logs when timed-out
  work settles. The startup log includes a `Derived-state recovery: ...` summary
  so operators can tell whether recovery ran.
- `Tool dispatch queue timed out after ...` means a foreground MCP tool request
  waited longer than `concurrency.toolQueueTimeoutMs` (default `30000`) for a
  dispatch slot before its handler started. The failed tool response is
  retryable and classified as `unavailable`; running tools or indexing work are
  not canceled. If startup derived-refresh recovery is running, foreground tool
  calls wait for it to finish instead of using this timeout, and server-side
  index progress reports `Deferred work is running (..., NN%)` when a progress
  estimate is available.
- `waitForDerivedRefreshIdle timed out` means a foreground refresh stopped
  waiting for the background derived-refresh queue to become idle. It logs a
  warning and proceeds; it is not controlled by
  `SDL_DERIVED_REFRESH_TIMEOUT_MS`.

For derived refresh diagnosis, inspect:

```bash
sdl-mcp tool repo.status --repo-id <repo-id>
```

Check `derivedState.structuralStale`, `derivedState.semanticStale`, the dirty
flags, `derivedState.lastError`, and `derivedState.nextBestAction`. The legacy
`derivedState.stale` field is the aggregate of both readiness classes. For stale
graph-derived state from an interrupted run, reindex only when current structural
graph behavior is required and after explicit user approval in the current turn.
Semantic-only dirty flags are not enqueued into graph startup recovery. Continue
with available retrieval lanes while semantic refresh work clears them. Increase
`SDL_DERIVED_REFRESH_TIMEOUT_MS` only when startup recovery is legitimately
long-running. If it repeatedly times out at the same phase, treat that as an
indexing or LadybugDB contention issue first.

For parser-provenance recovery, reindex only if AST/provenance-dependent behavior
is required; otherwise use a file-based fallback. Parser-provenance errors expose
this default as `recoveryAction: "fileFallback"`.

For tool dispatch stalls, inspect the warning fields in the log. When
`indexingActive` is `true`, SDL-MCP intentionally narrows foreground tool
dispatch to one slot to reduce database contention. Raise
`concurrency.toolQueueTimeoutMs` only when queued tools should wait longer during
ordinary indexing dispatch. If the CLI reports a delegated server-busy failure,
retry after the server finishes its active index or startup recovery work; the CLI will not fall back to
direct indexing while the live HTTP server owns the graph DB lock. Do not raise
`maxToolConcurrency` first unless you have evidence that the database can
tolerate more concurrent foreground work.

If delegated CLI indexing reports `read ECONNRESET` immediately after
`Cluster refresh`, the HTTP server likely exited in LadybugDB native code while
replacing FTS-indexed cluster nodes. Restart the server with a build that drops
and rebuilds `cluster_search_text_v1` around topology-changing cluster
replacement, then rerun the incremental refresh. Do not force direct indexing
while the server-owned graph DB lock is active.

If a full index fails with `Deferred retrieval index build failed for required
index(es): ...`, the graph load reached the post-index retrieval bootstrap but
LadybugDB failed a required secondary index operation such as
`symbol_search_text_v1`. This is different from an unavailable FTS/vector
extension, which SDL-MCP still treats as a graceful retrieval downgrade. Check the
server log for the preceding `CREATE_FTS_INDEX` or `CREATE_VECTOR_INDEX` warning
and verify the same command through the `node .../dist/main.js` entrypoint when a
platform shell wrapper is suspected.

### Windows FTS OpenSSL Runtime

On Windows x64 with LadybugDB 0.18.1, FTS needs SDL's temporary OpenSSL runtime package.

Symptoms:

- `LOAD EXTENSION fts` reports missing `libssl-3-x64.dll` or `libcrypto-3-x64.dll`.
- FTS is unavailable after installing with `--omit=optional`.
- `SDL_MCP_DISABLE_NATIVE_ADDON=1` or an old `sdl-mcp-native` package disables FTS.
- A clean machine loads a different OpenSSL DLL from `PATH`.

Recovery:

- Reinstall with optional dependencies enabled.
- Keep `sdl-mcp-native` at the same version as `sdl-mcp`.
- Do not add Git, Conda, or system OpenSSL directories to global `PATH`.
- Verify package hashes and module origins with the Windows FTS compatibility test.
- See [Ladybug Windows OpenSSL runtime](./ladybug-windows-openssl.md).

### Stale Results

- Run `sdl-mcp index`
- Or call `sdl.index.refresh` with `incremental`
- Enable watcher mode if desired (`index --watch`)

### HTTP Listens but `/health` Returns `503`

A listening HTTP port proves process liveness only. SDL-MCP reports ready after one global storage preflight passes and every configured watcher starts. A failed preflight or watcher prints `DEGRADED — watchers not ready`, keeps read-only and status diagnostics available, returns `503` from `/health`, and rejects mutations with `STORAGE_NOT_WRITE_READY`.

Do not route writes to a degraded server. Inspect the reason in the startup log, preserve any suspect database family, and follow the storage recovery steps below when the preflight fails. Fix the watcher provider or start with `--no-watch` when the storage check passes but watcher startup fails.

### Graph Integrity or Physical Symbol Failure

Treat physical Symbol identity failures and current-revision graph-integrity
failures as storage incidents. Repeated refresh attempts cannot repair a
partially committed graph and can destroy useful forensic evidence.

Common symptoms include:

- a physical Symbol count that exceeds the distinct `symbolId` count
- a label scan that projects empty `symbolId`, `name`, `astFingerprint`, or
  `scipSymbol` values while primary-key point lookups still resolve the
  original Symbol IDs
- a primary-key or foreign-key failure during provider or legacy fallback work
- equal expected and actual graph counts with a different fileless digest
- a populated full refresh that reports `SafeRebuildRequiredError`
- a watcher that becomes stale after a permanent integrity failure

Use this recovery sequence:

1. Stop every SDL-MCP process that can own the active graph.
2. Resolve the effective config and graph paths with `sdl-mcp info`. Check
   `SDL_GRAPH_DB_DIR`, `SDL_GRAPH_DB_PATH`, and `SDL_DB_PATH` as well as
   `graphDatabase.path`.
3. Leave the stopped active family in place and record its complete member list
   and hashes before recovery. Do not manually copy, move, rename, or replace a
   family; its receipt is a family member bound to the canonical primary identity
   and exact primary/WAL bytes. Use separate backup tooling only for a forensic
   artifact that will never be configured as an SDL-MCP database.
4. Choose an absolute candidate path that does not exist, then run:

   ```bash
   sdl-mcp index --force --safe-rebuild /absolute/path/to/recovered-graph.lbug
   ```

5. Accept the candidate only when the command reports successful checkpointed
   storage validation after each configured repository. That gate recomputes
   every previously indexed repository's persisted integrity manifest and
   compares every scan-visible Symbol string projection with a scalar
   primary-key lookup. The command repeats final validation after checkpoint,
   close, and reopen.
6. Keep SDL-MCP stopped while you update the config, launcher, and environment
   overrides to the same candidate path. Retain the old database family for
   rollback.
7. Restart SDL-MCP and check `sdl.repo.status`, Symbol lookup, graph retrieval,
   and enabled FTS for every configured repository.

The per-family lock detects cooperating SDL-MCP owners and is held through the
entire native database lifetime and strict close. It cannot detect an unrelated
program that opened LadybugDB directly, so you must stop that owner before the
safe rebuild. The command also fails if the reserved target appears or changes
between validation gates, retains a partial or invalid candidate for diagnosis,
and never changes the active database or configuration.

Within one process, switching database paths requires
`await closeLadybugDb({ strict: true })` before opening the new path. Once close
starts, queued and later root database operations fail while active nested work
drains. If native close fails, SDL-MCP keeps the lifecycle fence, family lease, and
any failed short-lived shadow handles in place; retry strict close rather than
opening another family. The admission
queue accepts at most 256 waiters and does not add a universal operation timeout.

All configured repositories are rebuilt because `Symbol.symbolId` is a global
primary key inside one shared database. For example, SCIP-IO can be the first
repository and LSP-IO can be the later repository whose write exposes a global
storage defect. This does not mean that both providers are indexing the same
repository. Use separate config and graph database instances when repositories
require operational isolation.

With LadybugDB 0.18.1, a `Symbol` table initially populated by node `COPY` can
later diverge between label scans and primary-key point lookups after another
Symbol append—including parameterized `MERGE`—and checkpoint. A later switch to
`MERGE` does not repair that baseline. SDL-MCP therefore creates active Symbol
tables with parameterized `MERGE` from the start and blocks production shadow
staging and activation. An existing database that may contain an activated
COPY-built baseline needs the clean safe rebuild above.

Relationship `COPY` did not reproduce this node-column failure and remains
enabled for ownership and known-endpoint dependency relationships.

Saved-file reconciliation does not require routine full refreshes. The patch transaction writes graph rows, canonical dependency placeholders, manifest changes, and the new integrity revision together. The background verifier coalesces rapid revisions and recovers a lost wakeup.

While the current revision is `verifying`, graph reads remain available and later saved-file commits can advance the revision without waiting for a full-graph scan. If verification reaches `failed`, SDL-MCP no longer has a trustworthy write baseline: reads remain available from the manifest-backed graph, but new writes fail closed and the watcher becomes stale instead of amplifying damage with refresh retries.

### After Upgrading SDL-MCP

If you see errors that say a database is "not compatible with the current graph
engine," stop SDL-MCP and use the safe-rebuild sequence above. Do not delete the
existing database until the replacement has passed post-reopen and live
validation.

Before changing the installed `kuzu` alias, qualify the candidate driver against a pre-staged offline snapshot or quarantined family:

```powershell
npm run qualify:ladybug -- --source <closed-db.lbug> --config <config.json> --expect-version <version>
```

Stop every source owner before running the command. The gate fingerprints and copies the source as bytes, rejects canonical or hardlink aliases to active families, and opens only the disposable clone. It runs two fresh-process write, checkpoint, close, reopen, verify, and remove cycles. Successful clones are removed; failed clones are retained and reported. The source, including a quarantined original, remains untouched.

### Watcher Failure Modes

If file watching is enabled by default and becomes unstable, use:

```bash
sdl-mcp serve --no-watch
```

Then run manual refreshes with `sdl-mcp index` until the underlying issue is fixed.

The default provider policy is `indexing.watchProvider: "auto"`, which tries
Watchman, then Chokidar, then Node `fs.watch`. Set `watchProvider` explicitly
only when you want startup to fail visibly if that provider is unavailable. In
`auto`, Watchman startup/runtime failures are recorded in `watcherHealth` as a
fallback reason before SDL-MCP switches to the next provider. Missing-Watchman startup probes are cached for the current server process, so
additional repos reuse the fallback without repeating the same missing-binary
warning.

Chokidar applies repository `ignore` globs during watcher startup. Watchman
subscribes with source-file suffix filters and then applies SDL's canonical
ignore/extension guards as events arrive. Dependency-heavy package managers
such as Bun should normally be covered by the default `**/node_modules/**`
ignore; add repo-specific `ignore` entries only for generated directories that
live outside those defaults.

#### Watchman recrawls or fresh instances

- Symptom: `watcherHealth.provider` is `watchman` and Watchman warning,
  recrawl, or fresh-instance counters increase.
- Cause: Watchman lost a precise event boundary and sent a conservative resync
  notification.
- Resolution:
  - let SDL-MCP run the scheduled incremental refresh; it intentionally avoids
    treating every Watchman file in that notification as a precise saved-file
    patch
  - inspect Watchman logs if recrawls repeat frequently
  - add a repo-owned `.watchmanconfig` with ignored generated directories only
    if you want Watchman to prune them at the OS watcher layer; SDL-MCP does not
    create or modify `.watchmanconfig`

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
  - if you do not need the Rust engine, set `indexing.engine: "typescript"`; the default is `indexing.engine: "rust"` when the native addon is available

### Missing Symbols for JS Files With TS Counterparts

- Symptom: `.js` files are not indexed even though they are listed in `languages`
- Cause: when both `foo.ts` and `foo.js` exist at the same path, the scanner excludes the JS file to avoid indexing compiled output alongside source
- Resolution: this is expected behavior. If the JS file is hand-written source (not compiled), remove or rename the corresponding `.ts` file

### Server Starts But Agent Cannot Use Tools

- Ensure agent points to `sdl-mcp serve --stdio`
- Validate generated client config from `init --client <name>`
- Use `sdl-mcp info` to confirm the resolved config path, log file path, and native-addon status
- Confirm process logs in the active log file. Default server logs are session-scoped under `~/.sdl-mcp/logs/sdl-mcp-<timestamp>-<pid>-<counter>.log`; set `SDL_LOG_FILE` only when you want a stable path. Enable `SDL_CONSOLE_LOGGING=true` if you want stderr mirroring during manual debugging

### Log File Missing or Unexpected

- Symptom: no logs in the configured location, or logs appear under a temp directory
- Cause: `SDL_LOG_FILE` or the derived session log path is not writable
- Resolution:
  - run `sdl-mcp info` and inspect `logging.path` and `logging.fallbackUsed`
  - fix permissions or choose a writable `SDL_LOG_FILE`
  - set `SDL_CONSOLE_LOGGING=true` temporarily if you need stderr mirroring while fixing file logging

### LadybugDB Issues

#### Incoherent STRING values during a large scan

- Symptom: graph validation reports inconsistent or malformed STRING values during a large multi-column scan, often after a checkpoint/reopen boundary.
- Cause: LadybugDB 0.18.1 has a confirmed result-projection defect for this scan shape. It is not, by itself, proof of logical graph corruption or damaged source data. SDL-MCP's 0.19.0 qualification passed 15 behavioral phases, but [upstream issue #725](https://github.com/LadybugDB/ladybug/issues/725) remains open, so treat the result as upgrade evidence rather than proof.
- Resolution:
  - do not repair, reopen, or upgrade the current or quarantined database family in place
  - qualify the installed driver only from a stopped, offline source family that is separate from every configured active database:

    ```bash
    npm run qualify:ladybug -- --source /absolute/path/to/offline-source.lbug --config /absolute/path/to/sdlmcp.config.json --expect-version 0.19.0
    ```

  - the qualifier rejects source paths, family members, and filesystem aliases that identify an active database; it verifies the offline source family's fingerprint after copying and after every phase
  - a successful qualification removes its disposable clone. A failed qualification retains and prints its diagnostic clone path; preserve that clone for investigation
  - complete the separate safe-rebuild/cutover procedure in the [CLI reference](./cli-reference.md#sdl-mcp-index) before using a qualified driver in production. This code change does not perform a production cutover

#### Lineage receipt or lock prevents startup

- Symptom: startup reports an old-format, missing, or stale lineage receipt, a database-family mismatch, or an active family lock.
- Cause: the previous process crashed before strict close, the family was copied, moved, renamed, replaced, or changed after its receipt, or another cooperating SDL-MCP process still owns it. A crash deliberately leaves the prior receipt stale.
- Resolution:
  - ensure no other `sdl-mcp serve` or `sdl-mcp index` process is running; stop direct LadybugDB users separately because they do not participate in the cooperative lock
  - SDL-MCP never deletes a stale family lock automatically. A PID can die while another process replaces the lock, so path-based reclamation could delete the new owner's lock
  - only when the error explicitly reports that the recorded PID is not running: keep every owner stopped, verify the database family is offline, and remove only the exact `.sdl-family.lock` path printed in the error (for example, `Remove-Item -LiteralPath "<exact-lock-path>"`)
  - do not manufacture, copy, edit, or delete the lineage receipt, primary database, or WAL; if lock ownership remains ambiguous, leave it in place
  - keep the rejected family intact and use `index --force --safe-rebuild` with a new absolute target path when the receipt or database family is stale

#### Concurrent access errors

- Symptom: intermittent query failures or "transaction conflict" errors when multiple agents connect
- Cause: LadybugDB allows concurrent reads but serializes writes; long-running write transactions can conflict
- Resolution:
  - use HTTP transport (`serve --http`) for multi-agent setups — sessions are isolated
  - avoid running `sdl-mcp index` while agents are actively querying; index during quiet periods or use incremental mode
  - if errors persist, restart the server to clear stale transaction state

#### WAL file stays large or current

- Symptom: `<graphDatabase.path>.wal` is large, or its modified time is newer than the main `.lbug` database file
- Cause:
  - LadybugDB commits can remain in the WAL until a checkpoint; the main `.lbug` timestamp is not a reliable "last write" signal
  - Indexing, provider-first SCIP materialization, embeddings, and derived-state refreshes can create large WAL bursts
  - MCP tool calls also write compact Audit rows, so read-heavy work can keep the WAL timestamp current even when graph content is unchanged
- Resolution:
  - SDL-MCP enables strict WAL replay and disables LadybugDB's native automatic checkpoint; it owns scheduled, manual, and pre-close checkpoints instead
  - maintenance checkpoints only when the WAL is quiet, the write pool is idle, and no indexing/post-index session is active. Admission blocks new database operations and drains active ones before a checkpoint runs
  - current defaults: check every 60s, checkpoint when WAL is at least 32 MiB after 30s quiet time, or when a non-empty WAL has been quiet for 15 minutes; checkpoint attempts are rate-limited to once every 5 minutes
  - graceful shutdown performs a final best-effort checkpoint only after the write connection drains

#### Post-index finalization reports a timeout

- Symptom: indexing logs that post-index finalization exceeded `postIndexSessionTimeoutMs`.
- Cause: this is a soft deadline for embeddings, summaries, deferred index work, memory sync, and audit flushing after pass-1/pass-2. It does not cancel the work, release its write slot, or release LadybugDB operation admission.
- Resolution:
  - wait for the reported session to settle before restarting, checkpointing, or beginning another maintenance operation
  - increase `repos[].postIndexSessionTimeoutMs` only when the observed finalization duration needs a larger reporting threshold; it does not cap total finalization time
  - do not run direct HNSW index commands as a workaround. SDL-MCP fences an HNSW rebuild with exclusive operation admission and pre/post checkpoints

#### Shutdown forces exit before cleanup finishes

- Symptom: shutdown logs `Cleanup did not finish within ... forcing exit`
- Cause: a cleanup step, usually LadybugDB drain/checkpoint or an active HTTP session teardown, did not finish before the shutdown watchdog fired
- Resolution:
  - current builds allow 60 seconds for graceful shutdown; LadybugDB shutdown drains use bounded 5-second windows, read-connection drains run in parallel, and shutdown skips the final checkpoint when the write connection fails to drain
  - if the message includes a cleanup name, inspect that subsystem first; repeated `db` timeouts usually mean an active index/post-index write or a stuck native DB call
  - after a forced exit, run `sdl-mcp doctor` or restart the server before indexing; startup and shutdown both perform best-effort WAL checkpoints

#### Database incompatible after upgrade

- Symptom: error "not compatible with the current graph engine" on startup
- Cause: LadybugDB schema version changed between SDL-MCP releases in a way the current build cannot migrate automatically
- Resolution:
  - restart SDL-MCP once to allow any pending forward migrations to run
  - if the database is still reported as incompatible, keep it stopped and use `index --force --safe-rebuild` to create and validate a replacement
  - retain the old database family until the replacement passes live validation

### Semantic / Embedding Setup Issues

#### Symbol embeddings reach 100% but indexing continues

- Symptom: `Symbol Embeddings` reaches 100%, then indexing appears idle for several minutes.
- Cause: embedding inference is complete, but LadybugDB must still build the Symbol HNSW vector index. Current builds report this separately as `Symbol Vector Index: <model>: building HNSW` and then `ready`.
- Resolution:
  - use `index --diagnostics` and inspect the `semanticReadiness.symbolEmbeddings:<model>.hnsw.create` timing
  - the same diagnostics report captures process RSS, heap, external memory, array buffers, and system free memory before/after inference and HNSW construction
  - do not drop or rebuild the active graph's vector index manually
  - to evaluate a lower construction setting without mutating the source graph, stop SDL-MCP and run `npm run bench:hnsw-efc -- --source <absolute-lbug-path> --efc 200,100 --queries 20 --k 10`
  - the default `--load-mode create` streams Jina vectors from the source opened read-only into fresh rows; add `--load-mode update` to first create every row with a null vector and then update the existing rows in production-sized batches
  - if both synthetic modes remain much faster than production, use `--load-mode clone` to copy and validate the complete stopped LadybugDB family before discovering and rebuilding its unique Jina index only on the temporary clone; use `--index-name <name>` only when an indexless clone should use a non-default name
  - a slow clone rebuild implicates persistent graph shape or storage state; a fast clone rebuild implicates fresh-index session state or memory pressure
  - safe rebuilds use the same in-session HNSW lifecycle as ordinary full indexes, then checkpoint, reopen once, and validate the durable candidate before publication
  - compare both load modes before tuning `efc`; the benchmark builds each candidate in a temporary database, excludes null vectors from exact-cosine ground truth, compares logical symbol IDs, and deletes the temporary database afterward
  - repeat once with `--efc 100,200` to reverse warm-cache ordering before changing the production setting; require recall parity as well as a meaningful build-time reduction

#### ONNX Runtime not loading

- Symptom: warning "Failed to load ONNX runtime" or semantic search returns no results
- Cause: `onnxruntime-node` native binary is missing or incompatible with the current platform/Node.js version
- Resolution:
  - run `npm rebuild onnxruntime-node` to recompile for your platform
  - on Windows, ensure the Visual C++ Redistributable is installed
  - if the ONNX binary cannot be built, set `semantic.enabled: false` in config to disable semantic features and fall back to text-based search
  - check `sdl-mcp doctor` output for ONNX-specific diagnostics

#### Embedding model download fails

- Symptom: first-run hangs or errors during model download (e.g., `nomic-embed-text-v1.5` or `jina-embeddings-v2-base-code`)
- Cause: network restrictions or proxy settings blocking the model downloads (~138 MB for quantized Nomic; ~321 MB FP16 and ~162 MB quantized for Jina Code)
- Resolution:
  - ensure outbound HTTPS access to Hugging Face model hub
  - configure proxy via `HTTPS_PROXY` environment variable if needed
  - run `node scripts/postinstall-models.mjs --strict`: with `SDL_MCP_SKIP_MODEL_DOWNLOAD` unset, it installs and verifies the pinned default model set; with `SDL_MCP_SKIP_MODEL_DOWNLOAD=1`, it verifies existing artifacts and fails if required files are missing
  - use `semantic.modelCacheDir` to point SDL-MCP at a pre-seeded model cache for restricted or offline environments

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
