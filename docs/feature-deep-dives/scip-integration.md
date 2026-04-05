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

You can ingest multiple SCIP files (e.g., one for TypeScript and one for Go in a polyglot repo) by listing them in the `scip.indexes` array.

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
    "autoIngestOnRefresh": true
  }
}
```

### Field Reference

| Field                         | Type    | Default | Description                                                                                                                                                 |
| :---------------------------- | :------ | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | boolean | `false` | Master switch for SCIP integration. When false, all SCIP features are disabled.                                                                             |
| `indexes`                     | array   | `[]`    | List of SCIP index files to ingest. Each entry has a `path` (relative to repo root) and an optional `label` (e.g., `"typescript"`, `"go"`) for diagnostics. |
| `externalSymbols.enabled`     | boolean | `true`  | Whether to create graph nodes for external dependency symbols (symbols from packages outside the repo).                                                     |
| `externalSymbols.maxPerIndex` | number  | `10000` | Cap on the number of external symbols ingested per index file. Prevents the graph from growing unbounded when a large dependency tree is present.           |
| `confidence`                  | number  | `0.95`  | Confidence score assigned to SCIP-resolved edges. Reflects compiler-grade certainty (higher than heuristic edges, which typically score 0.5-0.8).           |
| `autoIngestOnRefresh`         | boolean | `true`  | When true, `sdl.index.refresh` automatically re-ingests SCIP files if they are newer than the last ingestion timestamp.                                     |

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

The `.scip` file is a protobuf binary. You can inspect it with `scip print index.scip` (from the [scip CLI](https://github.com/sourcegraph/scip)).

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
