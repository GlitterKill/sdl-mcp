# src/indexer/ - Symbol Extraction Pipeline

## OVERVIEW
Scans files, parses ASTs via tree-sitter (or Rust native addon), extracts symbols and edges, writes to LadybugDB. Supports 11 languages via adapter pattern.

## PIPELINE
1. `scanner.ts` - File discovery (respects .gitignore via fast-glob)
2. `parser.ts` - Dispatch: Rust native (`rustIndexer.ts`) or TS worker pool (`workerPool.ts` + `worker.ts`)
3. `treesitter/` - AST extraction: `extractSymbols.ts`, `extractCalls.ts`, `extractImports.ts`
4. `adapter/` - Language-specific adapters (implement `LanguageAdapter` interface)
5. `edge-builder/` - Edge construction: `call-resolution.ts`, `import-resolution.ts`, `pass2.ts`
6. `pass2/` - Second-pass resolvers (cross-file type resolution)
7. `import-resolution/` - Language-specific import resolvers
8. `metrics-updater.ts` - Fan-in/out/churn computation
9. `cluster-orchestrator.ts` - Post-index cluster + process computation
10. `fingerprints.ts` - AST fingerprint for stable SymbolIDs

## WHERE TO LOOK

| Task | File |
|------|------|
| Add new language | `adapter/<lang>.ts` (implement `LanguageAdapter`) |
| Fix symbol extraction | `treesitter/extractSymbols.ts` |
| Fix call resolution | `edge-builder/call-resolution.ts` |
| Fix import resolution | `import-resolution/<lang>-adapter.ts` |
| Rust native indexer | `rustIndexer.ts` (bridge to napi-rs) |
| Plugin system | `adapter/plugin/` (external adapter loading) |

## CONVENTIONS
- Adapters produce pure domain objects (symbols, edges) - NO DB writes
- Rust addon fallback: always check `SDL_MCP_DISABLE_NATIVE_ADDON` env
- Worker pool for TS fallback: `workerPool.ts` manages Node.js worker threads
- Incremental indexing: compares content hashes to skip unchanged files
- Full indexing: deletes all symbols/edges for repo, re-indexes everything

## ANTI-PATTERNS
- No DB writes in adapters - `indexer.ts` orchestrates all persistence
- No hardcoded language detection - use adapter registry
- No blocking tree-sitter operations on main thread (use worker pool)
- No `withWriteConn` in pass-2 resolvers - call `context.submitEdgeWrite(...)` (the dispatcher decides whether to flush immediately or coalesce per concurrency batch)
- No per-import `getFileByRepoPath` / per-target `getSymbolsByFile` in pass-2 - use `context.importCache` (built once at dispatcher start)

## LANGUAGE ADAPTERS
`typescript.ts`, `python.ts`, `go.ts`, `java.ts`, `rust.ts`, `csharp.ts`, `cpp.ts`, `c.ts`, `kotlin.ts`, `php.ts`, `shell.ts`

Plugin system: `adapter/plugin/` (external adapter loading via manifest)

## PERF SHARED INFRASTRUCTURE (pass-2)
- `Pass2ImportCache` (`pass2/types.ts`) - pass-level read cache populated by `buildPass2ImportCache` in `indexer-pass2.ts`. Replaces 30k+ point reads/run.
- `Pass1ExtractionCache` (`pass2/types.ts`) - pass-1's extraction outputs reused by the TS pass-2 resolver to skip re-parse. Populated by both engines (`process-file.ts`, `rust-process-file.ts`).
- `SubmitEdgeWrite` callback - dispatcher-owned write sink. Sequential path flushes immediately; parallel path coalesces per concurrency batch into one `withWriteConn` (delete+insert combined).
- `BatchPersistAccumulator.setProgressCallback` - drives the pass-1 drain progress bar. Threshold default `512` (was 200) to better fill UNWIND CHUNK windows.

## EMBEDDINGS (`embeddings.ts`, `embeddings-local.ts`)
- `refreshSymbolEmbeddings` accepts `concurrency` (1-8) and `batchSize` (1-128) from `semantic.embeddingConcurrency` / `semantic.embeddingBatchSize`.
- HNSW drop+rebuild path (`VECTOR_REBUILD_THRESHOLD = 0`) is the only working write path on LadybugDB 0.16.x (`LADYBUG#377`). When drop succeeds, the function coalesces ONNX batch results into a 256-item write buffer flushed once per chunk boundary (force-flush in `finally` before HNSW rebuild).
- Model variant + execution provider config: see `semantic.modelVariant` and `semantic.executionProviders`. Variants live in the `variants` map of each `ModelInfo` (`model-registry.ts`); platform allow-list for providers in `platformAllowedProviders()` (`embeddings-local.ts`).
