# Provider-First Indexing

Provider-first indexing is the new indexing direction for large repositories. It treats compiler or language-server facts as the first graph source and keeps the existing tree-sitter/Rust indexer as the fallback path.

## Pipeline Selection

`indexing.pipeline` controls selection:

- `"legacy"`: always use the current indexer.
- `"providerFirst"`: plan a provider-first run and keep legacy fallback available for unsupported or partially covered files.
- `"auto"`: use provider-first when SCIP or LSP coverage is configured; otherwise use legacy.

Provider priority is fixed as:

1. SCIP
2. LSP
3. Legacy fallback

SCIP wins because it provides compiler-grade definitions, references, relationships, external symbols, and per-document coverage quickly. LSP is primary only through bounded collection: workspace symbols, document symbols, definitions, references, diagnostics, and optional hierarchy calls when the server advertises support. SDL-MCP consumes configured LSP commands; it does not run package-manager install recipes for servers.

## Provider Facts

Provider output is normalized into a provider-neutral IR before any graph write:

- `FileFact`
- `SymbolFact`
- `OccurrenceFact`
- `EdgeFact`
- `ExternalSymbolFact`
- `DiagnosticFact`
- `CoverageFact`
- `ProviderRunFact`

SDL symbol IDs are derived from `repoId`, provider type, provider ID, native provider symbol ID, source path, and range. Provider version is intentionally excluded from the SDL ID so ordinary SCIP/LSP version drift does not corrupt identity; native provider IDs and versions are still stored on facts for audit and cache invalidation.

## Full Builds

The target full-build path is:

1. Collect SCIP indexes and capped LSP facts.
2. Emit staging artifacts.
3. Bulk-load a fresh shadow `.lbug`.
4. Validate row counts, relationship endpoints, and active generation coverage.
5. Build FTS and derived graph algorithm state.
6. Checkpoint only after writes and index builds are idle.
7. Activate the shadow DB with lock-aware close/reopen behavior.

Embeddings, LLM summaries, and semantic enrichment are not part of the first ready gate. They advance a separate semantic readiness state.

## Incremental Builds

Incremental provider-first refreshes stage facts by `generationId`, retire affected file facts, write bounded chunks through the single writer, and flip active generation only for affected files after validation. Files with full provider symbol and reference coverage skip legacy parsing; partial files receive targeted fallback for missing card or code surfaces.

## Current Implementation Status

The initial foundation is implemented:

- Config surface: `indexing.pipeline` and `indexing.providerFirst.*`.
- Provider-neutral IR types.
- Stable provider symbol and occurrence IDs.
- Durable LSP cache keys.
- SCIP document normalization into provider facts.
- Runtime provider-source planning exposed on `IndexResult.providerFirst`.

The existing indexer remains the materialization path while the shadow LadybugDB bulk loader and activation handoff are built out. This keeps current indexing behavior stable while provider facts and planning become testable.
