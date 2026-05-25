# Provider-First Indexing

Provider-first indexing is the new indexing direction for large repositories. It treats compiler or language-server facts as the first graph source and keeps the existing tree-sitter/Rust indexer as the fallback path.

## Pipeline Selection

`indexing.pipeline` controls selection:

- `"legacy"`: always use the current indexer.
- `"providerFirst"`: require an executable provider-first run. Until shadow LadybugDB activation and partial-coverage fallback land, SCIP full execution is gated and this mode fails with a clear error instead of silently running legacy.
- `"auto"`: use provider-first when an executable provider path is available; otherwise use legacy. In the current guarded phase, configured SCIP/LSP provider sources are reported and `auto` falls back to legacy.

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

SDL symbol IDs are derived from `repoId`, provider type, provider ID, native provider symbol ID, and source path. Provider version and definition ranges are intentionally excluded from the SDL ID so ordinary SCIP/LSP version drift and line movement do not corrupt identity; native provider IDs, versions, and ranges are still stored on facts for audit and cache invalidation.

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

Current guarded phase: exported staging helpers can collect SCIP documents and external symbols, normalize them into provider facts, and convert those facts into LadybugDB graph rows for the upcoming shadow loader. The public `indexRepo` refresh path does not execute provider-first collection yet: `auto` reports the planned provider source and falls back to legacy, while explicit `providerFirst` fails loudly until shadow `.lbug` activation and targeted legacy fallback for partial coverage are implemented. This avoids replacing the live graph with incomplete provider coverage or failing after a live graph mutation. Provider run, coverage, diagnostic, and occurrence facts are collected in memory by the helper path but are not yet persisted as first-class provider metadata rows.

## Incremental Builds

Target incremental provider-first refreshes will stage facts by `generationId`, retire affected file facts, write bounded chunks through the single writer, and flip active generation only for affected files after validation. Files with full provider symbol and reference coverage will skip legacy parsing; partial files will receive targeted fallback for missing card or code surfaces.

## Current Implementation Status

Implemented:

- Config surface: `indexing.pipeline` and `indexing.providerFirst.*`.
- Provider-neutral IR types.
- Stable provider symbol and occurrence IDs.
- Durable LSP cache keys.
- SCIP document normalization into provider facts.
- Runtime provider-source planning exposed on `IndexResult.providerFirst`.
- Full-refresh SCIP provider fact staging and LadybugDB row materialization helpers.
- Conservative SCIP occurrence edge materialization: imports and implementations can become edges, while broad references are retained as occurrences until a syntax-aware call pass proves invocation semantics.
- Explicit provider-first failure when executable provider activation is not safe.

Still pending: capped LSP execution, incremental provider generations, Parquet/CSV staging artifacts, shadow `.lbug` bulk loading, Windows activation handoff, and targeted legacy fallback for partial provider coverage.
