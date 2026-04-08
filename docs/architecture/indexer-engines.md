# Indexer Engines — TypeScript, Rust, and the Per-File Fallback

> **Audience:** contributors working on the Pass-1 extraction pipeline.
>
> **Scope:** explains the two interchangeable Pass-1 engines, how they are
> selected, and the per-file fallback contract that lets them interoperate
> inside a single indexing run.

## Engines

SDL-MCP has two Pass-1 engines that both emit the unified
`ExtractedSymbol` / `ExtractedImport` / `ExtractedCall` types defined in
`src/indexer/treesitter/extractCalls.ts` and `extractImports.ts`:

| Engine         | Entry point                                                | Implementation                                                                             | Languages                                                                          |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **TypeScript** | `runPass1WithTsEngine` in `src/indexer/indexer-pass1.ts`   | tree-sitter + JS workers via `src/indexer/parser/process-file.ts`                          | All 11 adapters: TS/JS, Python, Go, Java, Rust, C#, C++, C, Kotlin, PHP, Shell     |
| **Rust**       | `runPass1WithRustEngine` in `src/indexer/indexer-pass1.ts` | native crate in `native/src/extract/` via napi-rs, wrapped by `src/indexer/rustIndexer.ts` | 10 adapters: TS/JS, Python, Go, Java, Rust, C#, C++, C, PHP, Shell — **no Kotlin** |

Engine choice is a single flag: `indexing.engine: "typescript" | "rust"` in
the SDL-MCP config. Default is `"typescript"`. The Rust engine is opt-in
because it requires the native addon to be built and present on the
platform.

## Pass-2 is engine-agnostic

Pass-2 (the resolver pipeline in `src/indexer/indexer-pass2.ts` that owns
call-edge resolution, barrel walking, and the `TsCallResolver`) runs
identically regardless of which Pass-1 engine produced the symbols. The
`TsCallResolver` (`src/indexer/ts/tsParser.ts`) is created **lazily** in
`indexRepoImpl` after Pass-1 completes for the Rust path, so Pass-1 code
paths never hold a reference to it and the program-cache lifecycle is
unaffected by which engine did the extraction. See Task 1.14 in the
implementation plan for the detailed argument.

## The per-file fallback contract

The Rust engine cannot extract from every language the TypeScript engine
supports — Kotlin has no stable Rust tree-sitter grammar today, and future
languages may land in the TS adapter layer before a Rust extractor exists.
Rather than forcing users to pick a single engine per repository, the Rust
path falls back to the TypeScript engine **per file** so a mixed-language
repo produces identical output under either engine setting.

### Signal

When `parseFilesRust` encounters a file whose extension is not mapped in
`native/src/lang/mod.rs::extension_to_language`, it synthesises a
`RustParseResult` via `buildUnsupportedLanguageResult`:

```ts
{
  relPath,
  contentHash: "",
  symbols: [],
  imports: [],
  calls: [],
  parseError: `Unsupported language: ${language || "unknown"}`,
}
```

This is the only value of `parseError` that `runPass1WithRustEngine`
recognises as a fallback signal. Real extraction errors (parse failures,
malformed source, panics) produce a different `parseError` string and are
NOT routed to the TS engine — the file is counted as `filesProcessed` but
contributes no symbols.

### Risk #8 optimisation (no round-trip)

`parseFilesRust` short-circuits the napi boundary for unsupported files:
the extension check in `src/indexer/rustIndexer.ts` runs **before** the
native call, so Kotlin and other unsupported files never cross into Rust.
The `buildUnsupportedLanguageResult` is populated synchronously in the
TypeScript wrapper. This matters because without it, a Kotlin-heavy repo
would pay the cost of a napi call that is guaranteed to produce nothing.

### Dispatch in `runPass1WithRustEngine`

```
for each file:
  if result.parseError === "Unsupported language: …":
    acc.rustFallbackFiles++
    acc.rustFallbackByLanguage[ext]++
    tsFallbackFiles.push(file)
    continue
  else:
    processFileFromRustResult(…)
    acc.rustFilesProcessed++

# second pass
for file in tsFallbackFiles:
  processFile(…)   # TS engine, shares the same acc, symbolIndex, etc.
  acc.tsFilesProcessed++
```

Both passes share the same `Pass1Accumulator`, `SymbolIndex`,
`pendingCallEdges`, `createdCallEdges`, and progress reporter. The
`tsResolver` argument passed to `processFile` is `null` during hybrid
Pass-1 because the resolver is only created lazily after Pass-1 finishes.

### Why not alternative shapes

- **Option (a) — fallback inside `parseFilesRust`.** Rejected: pulls TS
  engine dependencies into `rustIndexer.ts`, which is supposed to be a
  thin napi wrapper with a single responsibility.
- **Option (c) — a new top-level `runPass1Hybrid` dispatcher.** Rejected:
  duplicates the partitioning logic, forces an extra language lookup
  over the file list, and offers no benefit over keeping the dispatch
  inside `runPass1WithRustEngine`. A future refactor can hoist it if a
  third engine ever appears.

## Engine telemetry

`Pass1Accumulator` (in `src/indexer/indexer-init.ts`) carries four
counters populated by `runPass1WithRustEngine`:

| Field                    | Meaning                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rustFilesProcessed`     | Files that Rust extracted successfully.                                                                                                              |
| `tsFilesProcessed`       | Files that the TS engine extracted (both in TS-only mode and in fallback mode from the Rust path).                                                   |
| `rustFallbackFiles`      | Files that were routed from Rust to TS because Rust did not support the language. Equals the length of `tsFallbackFiles` inside the Rust path.       |
| `rustFallbackByLanguage` | `Map<extension, count>` for monitoring which extensions fall back most often — the dataset that future Rust-side work should be prioritised against. |

A summary line is logged at the end of every Rust-path Pass-1 run:

```
logger.info("Pass 1 engine breakdown", {
  rustFiles, tsFiles, rustFallbackFiles, perLanguageFallback
});
```

Task 1.12 surfaces these counters in the `index.refresh.complete` audit
event so they can be tracked across runs without scraping logs.

## Kotlin today

`.kt` / `.kts` files are served entirely by the TypeScript engine via the
fallback path. The `KotlinPass2Resolver` (1042 lines in
`src/indexer/pass2/resolvers/kotlin-pass2-resolver.ts`) continues to run
because Pass-2 is engine-agnostic, so the feature set users see under
`engine: "rust"` for Kotlin files is identical to `engine: "typescript"`.
Adding `tree-sitter-kotlin` to the Rust crate is a possible future task
but would not change the contract documented here — the fallback path
stays in place as a catch-all for any language Rust does not support at
any given moment.

## Enabling the Rust engine

The Rust engine is opt-in. To activate it:

1. Build the native addon (`npm run build:native`) or install the
   matching `sdl-mcp-native-<platform>` package.
2. Set `indexing.engine: "rust"` in your `sdlmcp.config.json`.
3. Run `sdl-mcp index` (or `sdl.index.refresh`) — mixed repos automatically
   fall back to the TS engine per file for anything Rust cannot parse
   (Kotlin today, plus any file whose extension is missing from
   `native/src/lang/mod.rs`, and any file Rust attempts to parse but
   returns an `Unsupported language:` marker for).

## `pass1Engine` telemetry (Task 1.12)

Every indexing run emits a `pass1Engine` block inside the
`index.refresh.complete` audit event (see `IndexRefreshTelemetry` in
`src/mcp/telemetry.ts`). The block is populated by
`derivePass1EngineTelemetry()` in `src/indexer/indexer.ts` from the
Pass-1 accumulator:

```jsonc
"pass1Engine": {
  "rustFiles": 412,             // files Rust extracted successfully
  "tsFiles": 18,                // files the TS engine extracted (includes fallback)
  "rustFallbackFiles": 18,      // subset of tsFiles that came via the Rust path's per-file fallback
  "perLanguageFallback": { "kt": 17, "kts": 1 }
}
```

TS-only runs emit `rustFiles: 0` and `rustFallbackFiles: 0`; the
`perLanguageFallback` map is empty. This lets dashboards diff engine
coverage over time without scraping logs.

## Running the engine parity harness

The parity harness in `tests/integration/engine-parity.test.ts` indexes
a synthetic multi-language fixture with both engines and compares
symbols, imports, and calls. It has two modes:

```bash
# Strict mode (default) — fails the run on any diff.
npm run test:parity

# Baseline mode — logs diffs but always exits 0. Used by CI while the
# Phase 2 Pass-2 resolver deepening work is still catching up.
SDL_PARITY_HARNESS_BASELINE=1 npm run test:parity
```

CI currently invokes the harness in baseline mode (`Engine parity
harness (baseline)` step in `.github/workflows/ci.yml`) so the 121
residual per-language diffs tracked in
[`devdocs/rust-engine-parity-gaps.md`](../../devdocs/rust-engine-parity-gaps.md)
do not block `main`. Phase 2 of the Rust engine rollout — per-language
Pass-2 resolver deepening — will close those heuristic-level gaps, at
which point CI will flip to strict mode and the baseline opt-in will be
removed.
