# Provider-First Indexing

Provider-first indexing is the new indexing direction for large repositories. It treats compiler or language-server facts as the first graph source and keeps the existing tree-sitter/Rust indexer as the fallback path.

## Pipeline Selection

`indexing.pipeline` controls selection:

- `"legacy"`: always use the current indexer.
- `"providerFirst"`: require an executable provider-first run for full SCIP refreshes. Fully covered files are materialized from provider facts, while uncovered or partial files are routed to the legacy indexer in the same run until targeted fallback exists. Incremental refreshes temporarily use the legacy incremental path. Unsafe provider output, such as duplicate documents, duplicate symbols, or files outside the scanned repo scope, fails instead of silently running legacy.
- `"auto"`: use provider-first when an executable provider path is available; otherwise use legacy. Full SCIP runs can mix provider materialization for fully covered files with same-run legacy fallback for uncovered or partial files. Unsafe provider output still fails because accepting contradictory graph facts can corrupt identity.

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

Current executable phase: full SCIP provider-first runs collect SCIP documents and external symbols, normalize them into provider facts, validate coverage against the scanned repository file set, and materialize provider-owned files/symbols/edges through the existing LadybugDB single-writer APIs. Existing symbols for provider-materialized files are removed before the provider rows are written so stale legacy symbols do not survive beside SCIP-owned symbols. Files whose provider coverage is missing or partial are excluded from provider materialization and indexed by the legacy path in the same run. `auto` falls back to a pure legacy run when SCIP execution fails before trustworthy facts are available, while unsafe provider facts fail in every mode. Provider run, coverage, diagnostic, and occurrence facts are still collected in memory and are not yet persisted as first-class provider metadata rows.

CLI output reports provider-first coverage separately from total indexed files. The `SCIP ingest` progress count is the number of SCIP documents decoded from provider indexes. The final `Provider-first coverage` line reports how many scanned repository files were fully provider-covered, how many provider-covered files still required legacy fallback, and how many scanned files were uncovered by providers.

Because broad SCIP references are not promoted into exact `call` edges without syntax-aware call proof, provider-first SCIP execution currently leaves cluster/process/algorithm derived state dirty after graph materialization. Metrics, file summaries, FTS, memory sync, and index events still run; graph-plus-algorithms readiness remains pending until the call-edge proof or pass-2 provider bridge lands.

## Incremental Builds

Target incremental provider-first refreshes will stage facts by `generationId`, retire affected file facts, write bounded chunks through the single writer, and flip active generation only for affected files after validation. Files with full provider symbol and reference coverage will skip legacy parsing; partial files will receive targeted fallback for missing card or code surfaces.

Current executable phase: provider-first incremental refreshes use the legacy incremental path with a structured fallback reason. This avoids mixing old SCIP overlay ingestion with incomplete provider generation semantics until active-generation flips are implemented.

## Current Implementation Status

Implemented:

- Config surface: `indexing.pipeline` and `indexing.providerFirst.*`.
- Provider-neutral IR types.
- Stable provider symbol and occurrence IDs.
- Durable LSP cache keys.
- SCIP document normalization into provider facts.
- Runtime provider-source planning exposed on `IndexResult.providerFirst`.
- Full-refresh SCIP provider execution, with active graph materialization for fully covered files through existing LadybugDB write APIs and derived algorithm gating until call-edge proof lands.
- Same-run legacy fallback for scanned files with missing or partial provider coverage, excluding those files from provider materialization to avoid duplicate provider/legacy symbols.
- Conservative SCIP occurrence edge materialization: imports and implementations can become edges, while broad references are retained as occurrences until a syntax-aware call pass proves invocation semantics.
- Explicit provider-first failure when SCIP execution, unsafe coverage validation, LSP execution, or provider graph facts are not safe.

Still pending: syntax-aware SCIP call-edge proof or pass-2 provider bridging, capped LSP execution, incremental provider generations, Parquet/CSV staging artifacts, shadow `.lbug` bulk loading, Windows activation handoff, and targeted fallback for only the missing card/code surfaces inside partial provider files.
