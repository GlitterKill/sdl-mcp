# SCIP Integration: Compiler-Grade Cross-References

[Back to README](../../README.md)

---

## What Is SCIP?

[SCIP](https://github.com/sourcegraph/scip) (Source Code Intelligence Protocol) is an open protocol from Sourcegraph for emitting compiler-grade code intelligence data. Language-specific "SCIP indexers" run your compiler or type-checker and emit a protobuf file (`.scip`) containing:

- Every symbol definition and its fully-qualified name
- Every reference to every symbol, cross-file and cross-package
- Relationship data: implements, overrides, type hierarchy
- External dependency symbols (e.g., symbols from `node_modules`, Go standard library, crate dependencies)

Unlike heuristic-based analysis, SCIP data comes directly from the compiler. If the compiler resolved a call, the SCIP file knows the exact target.

---

## Why SCIP Matters for SDL-MCP

SDL-MCP's default indexer uses tree-sitter to extract symbols and infer dependencies. Tree-sitter is fast and works across 11 languages, but it operates on syntax, not semantics. This means:

- **Cross-file call resolution is heuristic.** Tree-sitter sees `foo()` but cannot always determine which `foo` is being called when multiple definitions exist across files.
- **External dependencies are invisible.** Tree-sitter does not parse `node_modules` or Go module caches, so calls into third-party libraries are unresolved.
- **Interface implementations are not tracked.** Tree-sitter cannot determine that `MyService` implements `IService` without type information.
- **Barrel re-exports require guesswork.** The pass-2 resolver handles many cases, but complex re-export chains can defeat heuristic resolution.

SCIP supplements tree-sitter with exact compiler knowledge. After ingesting a SCIP index, SDL-MCP upgrades heuristic edges to compiler-verified edges, adds external dependency symbols as first-class graph nodes, and creates new relationship edges (like `implements`) that tree-sitter cannot discover.

**Tree-sitter and SCIP are complementary.** Tree-sitter provides the structural backbone (symbol extraction, skeleton IR, hot-path excerpts), while SCIP upgrades the semantic edges and fills in the gaps that syntax-only analysis misses.

---

## Supported SCIP Emitters

| Language                | Emitter            | Repository                                                                                         |
| :---------------------- | :----------------- | :------------------------------------------------------------------------------------------------- |
| TypeScript / JavaScript | scip-typescript    | [sourcegraph/scip-typescript](https://github.com/sourcegraph/scip-typescript)                      |
| Go                      | scip-go            | [sourcegraph/scip-go](https://github.com/sourcegraph/scip-go)                                      |
| Rust                    | rust-analyzer SCIP | [rust-lang/rust-analyzer](https://github.com/rust-lang/rust-analyzer) (built-in `scip` subcommand) |
| Java / Kotlin           | scip-java          | [sourcegraph/scip-java](https://github.com/sourcegraph/scip-java)                                  |
| Python                  | scip-python        | [sourcegraph/scip-python](https://github.com/sourcegraph/scip-python)                              |
| C# / .NET               | scip-dotnet        | [sourcegraph/scip-dotnet](https://github.com/sourcegraph/scip-dotnet)                              |
| C / C++                 | scip-clang         | [sourcegraph/scip-clang](https://github.com/sourcegraph/scip-clang)                                |

You can ingest multiple SCIP files (e.g., one for TypeScript and one for Go in a polyglot repo) by listing them in the `scip.indexes` array.

> **Note on `scip-clang`**: Support is best-effort. The decoder and symbol matcher are emitter-agnostic, so scip-clang `.scip` files decode and ingest cleanly, and the C/C++ tree-sitter adapters provide the SDL-side symbols to match against. C++ specific quirks (overload disambiguation by parameter types, template specializations, header/implementation splits, `operator()` descriptors) may match less precisely than first-class emitters until emitter-specific tuning is added to `src/scip/symbol-matcher.ts` and `src/scip/kind-mapping.ts`.

---

## Configuration

Add a `scip` section to your `sdlmcp.config.json`:

```json
{
  "scip": {
    "enabled": true,
    "indexes": [{ "path": "index.scip", "label": "typescript" }],
    "externalSymbols": {
      "enabled": true,
      "maxPerIndex": 10000
    },
    "confidence": 0.95,
    "autoIngestOnRefresh": true,
    "generator": {
      "enabled": false,
      "binary": "scip-io",
      "args": [],
      "autoInstall": true,
      "timeoutMs": 600000
    }
  }
}
```

The `generator` subsection wires sdl-mcp into the [scip-io](https://github.com/GlitterKill/scip-io) CLI to regenerate `index.scip` automatically before every refresh — see [Automatic Generation with scip-io](#automatic-generation-with-scip-io) below. The minimal opt-in is `scip.enabled: true` plus `scip.generator.enabled: true`; everything else defaults sensibly.

### Field Reference

| Field                          | Type    | Default     | Description                                                                                                                                                                                                                                                                                                                                 |
| :----------------------------- | :------ | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                      | boolean | `false`     | Master switch for SCIP integration. When false, all SCIP features are disabled.                                                                                                                                                                                                                                                             |
| `indexes`                      | array   | `[]`        | List of SCIP index files to ingest. Each entry has a `path` (relative to repo root) and an optional `label` (e.g., `"typescript"`, `"go"`) for diagnostics. When `generator.enabled` is true, `{ "path": "index.scip", "label": "scip-io" }` is auto-injected if not already present.                                                       |
| `externalSymbols.enabled`      | boolean | `true`      | Whether to create graph nodes for external dependency symbols (symbols from packages outside the repo).                                                                                                                                                                                                                                     |
| `externalSymbols.maxPerIndex`  | number  | `10000`     | Cap on the number of external symbols ingested per index file. Prevents the graph from growing unbounded when a large dependency tree is present.                                                                                                                                                                                           |
| `confidence`                   | number  | `0.95`      | Confidence score assigned to SCIP-resolved edges. Reflects compiler-grade certainty (higher than heuristic edges, which typically score 0.5-0.8).                                                                                                                                                                                           |
| `autoIngestOnRefresh`          | boolean | `true`      | When true, `sdl.index.refresh` automatically re-ingests SCIP files if they are newer than the last ingestion timestamp.                                                                                                                                                                                                                     |
| `generator.enabled`            | boolean | `false`     | Master switch for the scip-io generator integration. Has no effect unless `scip.enabled` is also true.                                                                                                                                                                                                                                      |
| `generator.binary`             | string  | `"scip-io"` | Override the scip-io binary name. The runner looks it up in PATH first (cross-platform `which`/`where`), then falls back to the sdl-mcp managed location at `~/.sdl-mcp/bin/scip-io[.exe]`.                                                                                                                                                 |
| `generator.args`               | array   | `[]`        | Extra string args appended after `index` when invoking scip-io (e.g., `["--no-clean"]`). The first arg is always `index`.                                                                                                                                                                                                                   |
| `generator.autoInstall`        | boolean | `true`      | When true and the binary is missing from both PATH and the managed location, sdl-mcp downloads it from the scip-io GitHub releases (with mandatory SHA-256 verification) into `~/.sdl-mcp/bin/`. When false, a missing binary just logs a warning and the refresh proceeds without scip-io.                                                 |
| `generator.timeoutMs`          | integer | `600000`    | Hard timeout for the `scip-io index` invocation, in milliseconds. Min `1000` (1s), max `1800000` (30min). Default 10 minutes. On timeout the process tree is killed and the refresh continues.                                                                                                                                              |
| `generator.cleanupAfterIngest` | boolean | `true`      | When the post-refresh ingest finishes, delete the generated `<repoRoot>/index.scip` so the regenerated file does not clutter the working tree. Skipped automatically when `args` contains `--output` / `-o` / `--output=...` (custom output paths are user-managed). Set to `false` to keep the file for inspection or third-party tooling. |

---

## Generating `.scip` Files

Run the appropriate SCIP emitter for your language before indexing with SDL-MCP:

### TypeScript / JavaScript

```bash
# Install the emitter
npm install -D @sourcegraph/scip-typescript

# Generate the SCIP index
npx scip-typescript index --output index.scip
```

### Go

```bash
# Install the emitter
go install github.com/sourcegraph/scip-go/cmd/scip-go@latest

# Generate the SCIP index
scip-go --output index.scip
```

### Rust

```bash
# rust-analyzer has a built-in SCIP emitter (no separate install needed)
rust-analyzer scip . --output index.scip
```

### Java

```bash
# scip-java uses a build plugin; see https://github.com/sourcegraph/scip-java
# For Maven:
mvn compile com.sourcegraph:scip-java:index

# For Gradle:
gradle compileJava :scip-java:index
```

### Python

```bash
# Install the emitter
pip install scip-python

# Generate the SCIP index
scip-python index --output index.scip
```

### C / C++

```bash
# scip-clang requires a compile_commands.json (generated by CMake, Bear, etc.)
# Install via Homebrew, prebuilt release, or build from source:
#   https://github.com/sourcegraph/scip-clang/releases
scip-clang --compdb-path=build/compile_commands.json --index-output=index.scip
```

The `.scip` file is a protobuf binary. You can inspect it with `scip print index.scip` (from the [scip CLI](https://github.com/sourcegraph/scip)).

---

## Automatic Generation with scip-io

Manually invoking the right SCIP emitter for every language in a polyglot repo and remembering to re-run it after every change is friction. SDL-MCP supports automating that step via [scip-io](https://github.com/GlitterKill/scip-io) — a polyglot SCIP orchestrator written in Rust that detects which languages your repo contains, downloads the matching upstream emitters, runs them in parallel, and merges everything into a single `index.scip` at the repo root.

When `scip.generator.enabled` is `true`, sdl-mcp runs `scip-io index` in the repo root **before** every `indexRepo()` call. The freshly written `index.scip` is then picked up automatically by the existing post-refresh ingest. There is nothing to wire up beyond the two flags.

### Languages scip-io Orchestrates

scip-io currently dispatches to upstream indexers for **TypeScript, JavaScript, Python, Rust, Go, Java, Scala, Kotlin, C#, Ruby, and C/C++**. It detects which languages are present in your repo, fetches each indexer (from GitHub releases, npm, dotnet tool, Coursier, or PATH), runs them, and merges the per-language outputs into one deterministic `index.scip`. See the [scip-io README](https://github.com/GlitterKill/scip-io) for the full matrix.

### Minimal Configuration

The smallest opt-in is two flags:

```json
{
  "scip": {
    "enabled": true,
    "generator": {
      "enabled": true
    }
  }
}
```

That's enough. With `scip.generator.enabled = true`, sdl-mcp:

1. Auto-injects `{ "path": "index.scip", "label": "scip-io" }` into `scip.indexes` at config-load time, so you don't need to also list the index file manually.
2. Runs `scip-io index` in the repo root before every `indexRepo()` invocation (CLI `sdl-mcp index`, MCP `sdl.index.refresh`, the file watcher, sync pull, HTTP reindex — every code path is covered).
3. Picks up the freshly written `index.scip` via the existing `autoIngestOnRefresh` path.
4. Deletes `<repoRoot>/index.scip` after the post-refresh ingest completes (controlled by `generator.cleanupAfterIngest`, default `true`). The file is regenerated on every refresh, so leaving it around just clutters the working tree (and shows up in `git status`). Cleanup is skipped automatically when `args` contains `--output` / `-o` / `--output=...` because the output path is then under user control. Set `cleanupAfterIngest: false` to keep the file for inspection or third-party tooling.

All the other `generator.*` fields default to sensible values: a 10-minute timeout, no extra args, `binary: "scip-io"`, and `autoInstall: true`.

### Auto-Install Behavior

If scip-io is not on PATH and is not in the sdl-mcp managed location, sdl-mcp can fetch it for you. The install path is intentionally narrow to keep the trust model small:

- **HTTPS only.** Downloads go through Node 24's built-in `fetch` — no shell, no curl-piped-to-bash, no remote install scripts.
- **Host allowlist.** Every URL pulled from the GitHub Releases API response is validated against `github.com` and `objects.githubusercontent.com` (and subdomains) before any network I/O. A tampered API response pointing at an attacker-controlled host is rejected with a clear error.
- **Mandatory SHA-256 verification.** sdl-mcp downloads the release's `SHA256SUMS.txt`, parses out the entry for the matching archive, and refuses to install if the digest does not match. **Releases that do not publish `SHA256SUMS.txt` are refused entirely** — there is no advisory/skip path. If you need to bypass this (e.g., a release without checksums), set `scip.generator.autoInstall = false` and install scip-io yourself.
- **200 MB hard cap** on archive size, enforced both via the `Content-Length` header and via streaming-byte counting (so a server that lies about content-length still cannot OOM the process).
- **Atomic install.** Archives are downloaded into a temp staging directory, extracted there, the binary is staged at `~/.sdl-mcp/bin/scip-io.tmp-<pid>`, smoke-tested via `scip-io --version`, and only then renamed to its final location. A crashed or aborted install never replaces a working binary.
- **System `tar` for extraction.** Both `.tar.gz` (Linux, macOS) and `.zip` (Windows) archives are extracted by the OS-provided `tar` binary (Windows 10+ ships bsdtar via `tar.exe`). No new npm dependency, no JS zip parser. Extracted paths are validated against the staging directory using `realpath`, so a malicious archive containing a symlink that escapes the staging directory cannot land outside `~/.sdl-mcp/bin/`.

The installed binary lives at `~/.sdl-mcp/bin/scip-io[.exe]`. Subsequent refreshes detect it there and skip the install path entirely.

If `autoInstall` is `false` and the binary is missing, sdl-mcp logs a warning naming the managed directory and the indexer continues normally — you simply do not get a fresh `index.scip` for that refresh.

### Concurrency and Lock Behavior

Two design choices keep scip-io from interfering with sdl-mcp's own indexing throughput:

- **Hook runs OUTSIDE `indexLocks`.** The pre-refresh hook fires in `indexRepo()` _before_ sdl-mcp acquires its per-repo serialization lock. A 10-minute scip-io run never blocks queued watcher-triggered incremental refreshes from grabbing their indexing slot.
- **Per-repo coalescing.** The runner maintains a per-repo `Map<repoId, Promise<void>>` lock. If a second `indexRepo()` arrives while a previous scip-io run for the same repo is still in flight, the second caller waits on the first's promise instead of starting a parallel `scip-io index` (which would race on writing `index.scip` at the repo root). Different repos still run scip-io concurrently.
- **Single-flight install lock.** The auto-install path itself uses a separate global lock so two parallel calls cannot both download the binary.

### Failure Mode: Non-Fatal

Every failure path on this integration is non-fatal:

- Binary missing + `autoInstall: false` → warn, skip the run, continue indexing.
- GitHub API unavailable → warn, skip, continue.
- SHA-256 mismatch / missing checksums file → warn, skip, continue.
- Archive extraction fails → warn, skip, continue.
- Smoke test fails → warn, skip, continue.
- `scip-io index` exits non-zero → warn (with up to 2KB of captured stderr), continue indexing with whatever `index.scip` happens to be on disk.
- Timeout fires → kill the process tree (Windows: `taskkill /T /F`; Unix: SIGTERM/SIGKILL on the process group), warn, continue.

The indexer always finishes its own pass. A broken scip-io setup will never block you from indexing.

### When to Disable

You should leave `scip.generator.enabled = false` (the default) when:

- You are running another SCIP emitter manually (e.g., `scip-typescript` from a CI step) and writing the `.scip` file yourself.
- Your repo's languages are not covered by scip-io's upstream indexers and the manual emitters do a better job for your stack.
- You need a specific upstream indexer version that scip-io does not pin to.
- You want minimum-overhead refreshes during heavy live-editing — scip-io adds wall-clock time even when sdl-mcp's own indexer would short-circuit.

In all of those cases, the legacy path (`autoIngestOnRefresh: true` + manually-managed `index.scip` + entries in `scip.indexes`) still works exactly as before.

---

## Ingestion

### Explicit Ingestion

Use the `sdl.scip.ingest` MCP tool action:

```json
{
  "repoId": "my-repo",
  "indexPath": "index.scip"
}
```

This reads the SCIP file, decodes it, matches SCIP symbols to existing tree-sitter symbols, creates new symbols and edges, and returns a summary of what changed.

### Dry Run

Preview what would happen without writing to the database:

```json
{
  "repoId": "my-repo",
  "indexPath": "index.scip",
  "dryRun": true
}
```

The response includes counts of symbols matched, created, and edges upgraded, but no graph mutations are applied.

### Auto-Ingest on Refresh

When `scip.autoIngestOnRefresh` is `true` (the default when SCIP is enabled), `sdl.index.refresh` automatically checks each configured SCIP index file. If the file's modification time is newer than the last ingestion, it is re-ingested after the tree-sitter indexing pass completes.

This means you can regenerate your `.scip` file (e.g., in a pre-commit hook or CI step) and SDL-MCP picks it up automatically on the next refresh.

---

## What Changes After Ingestion

### Symbol Enrichment

| Before (tree-sitter only)                  | After (SCIP ingested)                                                                                  |
| :----------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| `source: "treesitter"`                     | `source: "both"`                                                                                       |
| No `scipSymbol` field                      | `scipSymbol: "scip-typescript npm @sourcegraph/scip-typescript 0.1.0 src/`index.ts`/validateToken()."` |
| Heuristic call edges (confidence ~0.6-0.8) | Exact call edges (`resolution: "exact"`, `resolverId: "scip"`, confidence 0.95)                        |
| No interface implementation edges          | `"implements"` edges linking concrete types to interfaces/traits                                       |

### New Symbols

- **In-repo symbols** that tree-sitter missed (e.g., generated code, complex re-exports) are created with `source: "scip"`.
- **External dependency symbols** are created with `external: true`. These represent symbols from packages outside the repository (e.g., `express.Router`, `fmt.Println`, `serde::Serialize`).

### Edge Upgrades

Existing heuristic edges that SCIP can verify are upgraded:

- `resolution` changes from `"heuristic"` to `"exact"`
- `resolverId` is set to `"scip"`
- `confidence` is set to the configured SCIP confidence value (default 0.95)

New edges discovered by SCIP (not present in tree-sitter output) are created with `resolution: "exact"` from the start.

### New Edge Type: `implements`

SCIP introduces a new `"implements"` edge type for interface/trait implementations. For example, if `AuthService` implements `IAuthProvider`, SCIP creates a directed edge from `AuthService` to `IAuthProvider`. These edges participate in graph slicing and blast radius computation.

---

## How External Symbols Work

External dependency symbols are first-class nodes in the graph, but with limited scope:

- **Appear in symbol cards**: When a card's `deps.calls` references an external symbol, that symbol has a name, package, and fully-qualified SCIP identifier.
- **Appear in search results**: `sdl.symbol.search` returns external symbols by default. Use `excludeExternal: true` to filter them out.
- **Leaf nodes in graph slices**: Slices include external symbols when they are dependencies of in-scope symbols, but the BFS does not traverse further into external symbols (they have no in-repo dependents to follow).
- **Excluded from blast radius**: External symbols are not included in delta pack blast radius computation, since changes to third-party code happen outside the repository.
- **No code windows**: External symbols do not support `getSkeleton`, `getHotPath`, or `needWindow` (the source code is not in the repository).

### Controlling External Symbol Volume

Large projects can reference thousands of external symbols. Use `externalSymbols.maxPerIndex` to cap the count. When the cap is reached, the most-referenced external symbols are kept (sorted by in-repo fan-in). Set `externalSymbols.enabled: false` to skip external symbols entirely.

---

## SCIP and the Live Index

SCIP data integrates cleanly with SDL-MCP's live indexing system:

- **SCIP-only symbols survive reconciliation.** When `sdl.buffer.checkpoint` or `patchSavedFile` reconciles overlay symbols with the durable database, symbols with `source: "scip"` are preserved even if tree-sitter does not produce a matching symbol for that file. This prevents SCIP-discovered symbols from being deleted during live editing.
- **File deletion removes SCIP symbols.** If a file is deleted from the repository, all SCIP symbols associated with that file are removed during the next `index.refresh`.
- **SCIP edges on modified symbols are refreshed.** When a symbol is re-indexed by tree-sitter after an edit, its SCIP edges are preserved. The next `sdl.scip.ingest` (or auto-ingest on refresh) will re-verify and update them.

---

## Decoder Implementation

SDL-MCP includes two SCIP protobuf decoders:

| Decoder               | Location                 | Performance                   | When Used                                                       |
| :-------------------- | :----------------------- | :---------------------------- | :-------------------------------------------------------------- |
| Rust (native)         | `native/src/scip/`       | Fast (~10x for large indexes) | When the native addon is available (`sdl-mcp-native` installed) |
| TypeScript (fallback) | `src/scip/ts-decoder.ts` | Adequate for typical indexes  | Automatic fallback when the native addon is not available       |

The decoder is selected automatically at runtime. You can force the TypeScript fallback by setting `SDL_MCP_DISABLE_NATIVE_ADDON=1`.

---

## Troubleshooting

### Stale SCIP Files

**Symptom**: Edges reference symbols that no longer exist, or new symbols are missing SCIP data.

**Fix**: Re-run the SCIP emitter after source changes. If using `autoIngestOnRefresh`, regenerate the `.scip` file before running `sdl.index.refresh`. A CI step or pre-commit hook is a good place for this.

### Large External Symbol Count

**Symptom**: Ingestion is slow or the graph has thousands of external symbols cluttering search results.

**Fix**: Reduce `externalSymbols.maxPerIndex` (e.g., from 10000 to 2000), or disable external symbols entirely with `externalSymbols.enabled: false`. Use `excludeExternal: true` in `sdl.symbol.search` to filter them from results without removing them from the graph.

### Missing Symbols After Ingestion

**Symptom**: Symbols you expect to see are not matched or created.

**Fix**: Verify the SCIP emitter supports your language version and compiler settings. Run `scip print index.scip | grep "symbolName"` to confirm the symbol appears in the SCIP output. Check that the file paths in the SCIP index match the repository root (some emitters require running from the project root directory).

### Decoder Fallback Warnings

**Symptom**: Log messages about falling back to the TypeScript SCIP decoder.

**Fix**: This is not an error. The TypeScript decoder produces identical results; the only difference is speed. If performance matters for very large SCIP indexes (>100K symbols), install the native addon: `npm install sdl-mcp-native`.

---

## Related Tools

- [`sdl.scip.ingest`](../mcp-tools-detailed.md#sdlscipingest) - Ingest a SCIP index file
- [`sdl.index.refresh`](../mcp-tools-detailed.md#sdlindexrefresh) - Trigger re-indexing (auto-ingests SCIP when configured)
- [`sdl.symbol.search`](../mcp-tools-detailed.md#sdlsymbolsearch) - Search symbols (with `excludeExternal` filter)
- [`sdl.symbol.getCard`](../mcp-tools-detailed.md#sdlsymbolgetcard) - View SCIP-enriched symbol cards

[Back to README](../../README.md)
