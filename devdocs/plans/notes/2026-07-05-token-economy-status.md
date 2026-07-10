# 2026-07-05 Token Economy Status

## Stage 0 Baseline

- [x] `npm run build`: PASS (`runtime-sdl-mcp-1783302845355-650d5d0c3dc92fbd`, exit 0).
- [x] `npm run typecheck`: PASS (`runtime-sdl-mcp-1783302851587-c0b401122276d2e5`, exit 0).
- [x] `npm run lint`: PASS (`runtime-sdl-mcp-1783302876842-076fd030049531f9`, exit 0).
- [x] `npm test`: PASS (`runtime-sdl-mcp-1783303062636-9a76c2f114ae42c2`, exit 0, 177.6s).

## Companion-Plan Audit

- [x] trim-tool-response-fields Phase 1 model projection: SHIPPED.
  Evidence: `src/mcp/context-response-projection.ts` `shouldOmitToolSpecificModelField` removes root `whyApproved` and `estimatedTokens` from direct `code.needWindow` model responses in compact and full detail. The projection retains actionable `file`, `range`, `code`, `matchedIdentifiers`, `matchedLineNumbers`, and `warnings` evidence; `handleCodeNeedWindow` continues to construct the canonical response before the wire/model boundary. Commit: `a544aea7`.

- [x] compact agent payload projected response path: SHIPPED.
  Evidence: `src/mcp/context-response-projection.ts` exports `projectToolResultForModelContent`, `projectContextResultForUsageAccounting`, `projectBroadContextResult`, `isBroadContextResult`, and `BROAD_VISIBLE_FIELDS`; `src/server.ts` builds text from `modelPayload = projectToolResultForModelContent(...)` and projects `structuredContent`.

- [x] compact agent payload normal token-savings footer/meter append: SHIPPED.
  Evidence: `src/server.ts` `shouldIncludeDisplayFooter` only allows response footer text for `includeTelemetry: true` or `detail: "full"`; normal responses do not append the savings meter. Per-call savings still goes out as MCP notification via `renderUserNotificationLine`, not as response content.

- [x] usage.stats formattedSummary model dedupe: SHIPPED.
  Evidence: `src/mcp/context-response-projection.ts` `projectUsageStatsForModel` returns `{}` for compact detail. In full detail, it removes only the root `formattedSummary` field and preserves `session`, `wire`, and `history` in their original order. Structured wire/model content no longer duplicates `formattedSummary`, while `src/server.ts` continues to own user-display text independently. Commit: `a544aea7`.

- [x] symbol.getCard surface trim: SHIPPED.
  Evidence: live `symbolGetCard` for `src/mcp/tools/symbol.ts` `handleSymbolGetCard` omitted `repoId`, `visibility`, `detailLevel`, `version.ledgerVersion`, and `etag`. `src/mcp/context-response-projection.ts` `shouldKeepModelField` drops `repoId` for non-repo tools and drops compact debug fields.

- [ ] symbol.getCard canonical builder profiling: PENDING.
  Evidence: `src/services/card-builder.ts` `buildCardForSymbol` still constructs canonical fields such as `repoId`, `visibility`, `detailLevel`, and `version.ledgerVersion` before model projection. Commit `a544aea7` removes these fields only from the wire/model view, so it does not remove their construction cost. Profile the builder before deciding whether raw construction needs trimming.

## Stage 3 Search Miss Investigation

- [x] `queryFts` identifier splitting: SHIPPED.
  Evidence: `src/retrieval/orchestrator.ts` `buildIdentifierAwareFtsQuery` calls `splitCamelSubwords` and expands identifier-like queries before FTS execution. Camel-case and Pascal-case searches now reach the existing identifier fragments.

- [x] FTS indexed content includes identifier fragments: SHIPPED.
  Evidence: `src/indexer/symbol-enrichment.ts` `buildSearchText` stores `params.name` plus `splitIdentifierLikeText(params.name)`, summary fragments, path tokens, role tags, and signature terms. No schema or reindex change needed for this stage.

- [x] live-overlay subword matching: SHIPPED.
  Evidence: `src/live-index/overlay-reader.ts` `buildOverlaySearchTerms` calls `splitCamelSubwords`, deduplicates the primary terms and identifier fragments, and feeds them into `searchSymbolsWithOverlay`. Live-overlay search now matches camel-case and Pascal-case subwords alongside durable search.

## Chunk 3 Status

- [x] Stage 10 Answer-First Mode: SHIPPED in working tree. Commit: pending.
  Evidence: `src/mcp/context-answer-first.ts`, `src/mcp/tools/context.ts`, and `src/mcp/tools.ts` add opt-in `options.answerFirst` for explain/debug tasks, gate on summary provenance coverage, cap evidence at 8 entries, and fall back with `answerFirstFallback: "insufficient-summary-coverage"`. Focused verification: `runtime-sdl-mcp-1783376990911-dc55eec8ad7d1d52`.

- [x] Stage 11.1 Token price tags: SHIPPED in working tree. Commit: pending.
  Evidence: `src/code-mode/manual-generator.ts` and `src/code-mode/action-catalog.ts` carry static release-median token estimates; `src/code-mode/descriptions.ts` documents answer-first, near misses, digest runtime output, refs, and signal density. Focused verification: `runtime-sdl-mcp-1783377618520-f2a8bbabe9ce7845`.

- [x] Stage 11.2 file.read targeted-mode nudge: SHIPPED in working tree. Commit: pending.
  Evidence: `src/mcp/tools/file-read.ts` emits the deterministic large-untargeted-read hint when no targeting args are present; `src/mcp/tools.ts` exposes optional `hint` on inline file-read responses. Focused verification: `runtime-sdl-mcp-1783377939992-923c037404f0c3bb`.

- [x] Stage 11.3 Text vs structuredContent dedupe: SHIPPED in working tree. Commit: pending.
  Evidence: `src/mcp/tool-call-formatter.ts` summarizes context evidence instead of replaying full structured data and omits `formattedSummary` from generic text fallback while preserving structured output. Focused verification: `runtime-sdl-mcp-1783378026922-5454de516fe3db97`.

- [x] Stage 12 Agent workflow resources and release hygiene: SHIPPED in working tree plus workstation-local resources. Commit: pending for repo files; no commit for out-of-repo files.
  Evidence: `SDL.md`, templates, server instructions, manual/descriptions, `docs/feature-deep-dives/token-economy.md`, runtime/code-mode docs, `CHANGELOG.md`, `C:\Users\glitt\.codex\skills\sdl-mcp-agent-workflow\SKILL.md`, and `C:\Users\glitt\.claude\CLAUDE.md` document the new token-economy surfaces. Docs/static verification: `runtime-sdl-mcp-1783379029057-9a75431512b139ed`.

- [x] Stage 12.4 Final verification sweep: PARTIAL at this historical checkpoint.
  Evidence: combined focused suite passed (`runtime-sdl-mcp-1783378604288-bdeca3b4994e3f7f`); determinism passed (`runtime-sdl-mcp-1783378995054-d45d5893116ee1fa`); docs/static checks passed (`runtime-sdl-mcp-1783379029057-9a75431512b139ed`); golden and integration suites passed (`runtime-sdl-mcp-1783379401403-486654712d83cf52`). `npm test` failed twice at the harness boundary after reporting no individual node:test failures (`runtime-sdl-mcp-1783379216646-8d32d003001091f7`, `runtime-sdl-mcp-1783379586060-ee6577f802a4c337`). Round 2 later resolved that failure by updating `tests/unit/tool-output-visibility.test.ts`; the fresh full suite passed 596/596 files (`runtime-sdl-mcp-1783385012026-0b30184a1dbfc281`).

## Chunk 3 Verification Follow-up

- [x] Verifier finding: `sdl.action.search` compact model projection dropped `estTokens`. Fixed in `src/mcp/context-response-projection.ts`; regression covered by `tests/unit/context-response-projection.test.ts`. Fresh focused verification: `runtime-sdl-mcp-1783381153643-ce9047ccc5ff9da3`.

- [x] Verifier finding: answer-first debug canonical-test composition could not receive real card metrics. Fixed `src/mcp/tools/context.ts` to pass `card.metrics?.canonicalTest?.file` into the deterministic answer-first composer. Fresh focused verification: `runtime-sdl-mcp-1783381153643-ce9047ccc5ff9da3`.

- [x] Verifier finding: answer-first evidence cap lacked direct test coverage. Added `tests/unit/context-answer-first.test.ts` coverage for the 8-entry cap. Fresh focused verification: `runtime-sdl-mcp-1783381153643-ce9047ccc5ff9da3`.

- [x] Fresh static/docs gates after verifier fixes: `npm run typecheck`, `npm run lint`, `npm run docs:tools:check`, `npm run docs:workflows:check`, `npm run check:config-sync`, and `npm run check:schema-sync` passed (`runtime-sdl-mcp-1783381183581-eb38d1ecab699702`; lint still reports 43 warnings and 0 errors).

- [x] Fresh determinism/golden/integration gates after verifier fixes: determinism, `npm run test:golden`, and `npm run test:integration` passed (`runtime-sdl-mcp-1783381323582-56f140521df4db91`).

- [x] Full `npm test` historical failure: RESOLVED in Round 2. The failing rerun remains recorded as `runtime-sdl-mcp-1783381481261-65fe44932bef5ab5`; updating `tests/unit/tool-output-visibility.test.ts` aligned the expected Stage 11.3 summary, and the fresh full suite passed 596/596 files (`runtime-sdl-mcp-1783385012026-0b30184a1dbfc281`).

- [ ] External benchmark proof: OWNED BY THE BENCHMARK-ISOLATION TRACK. The historical default run fails on local `data/sdl-mcp-graph.lbug` WAL corruption (`runtime-sdl-mcp-1783380370919-f06f8e1ec1ba40ff`), and the historical temp `SDL_GRAPH_DB_PATH` run exceeded the 300s tool-call ceiling before returning a result. Do not claim benchmark green until that track persists an isolated artifact.

- [x] Live smoke from Task 12.4 Step 5: RECORDED in the two smoke sections below. The later rounds document dedupe refs, short-ID aliases, runtime digest savings, `file.read` hints, catalog `estTokens`, and answer-first behavior.

## Chunk 3 Verification Round 2 (2026-07-07)

- [x] Full `npm test` root cause found and fixed: `tests/unit/tool-output-visibility.test.ts` still asserted the pre-Stage-11.3 `fmtAgentContext` evidence-list text. Updated the expectation to the new `finalEvidence: N items` summary line. Fresh full suite: 596/596 files passed, exit 0 (`runtime-sdl-mcp-1783385012026-0b30184a1dbfc281`). The earlier "0/2 tests failed" digest reads were the digest parser summarizing only the final TAP documents; the harness exit code was authoritative.

- [x] Verifier finding: `loadAnswerFirstCards` dropped planned-but-unloadable cards from the provenance-coverage denominator (catch-and-skip), contradicting both the inline comment and the Stage 10 contract that load failures must reduce coverage. Fixed in `src/mcp/tools/context.ts`: failed loads now push a summary-less stub card so coverage drops and the gate falls back. Build + typecheck + focused tests green (47 pass / 0 fail).

- [x] Stage 10 determinism fixture deviation (accepted): the determinism harness runs with `codeMode: { enabled: false }`, so `sdl.context` is not an exposed tool there and a REGULAR answer-first fixture cannot be added without changing the harness surface. Byte-stability of the composer is covered by `tests/unit/context-answer-first.test.ts` (pure function, fixed inputs).

- [x] Live smoke (Task 12.4 Step 5), partial: dedupe refs verified live (`symbol.getCard` second call returned `{ ref, unchanged: true }`; repeated `sdl.context` returned `unchanged: true` refs for all repeated cards); short-ID reuse verified (second `symbol.search` extended the session alias dictionary without re-emitting known ids); runtime digest verified (failing node:test run returned a structured failure digest).
  - NOT verifiable against the currently running server: `answerFirst`, `file.read` untargeted-read `hint`, and catalog `estTokens` — the running MCP server process predates the chunk-3 dist (its `sdl.context` tool description lacks the new answerFirst text, `options.answerFirst: "yes"` passes schema validation, and a 173KB untargeted `file.read` artifact carries no `hint`). Restart the SDL-MCP server on the rebuilt dist and re-run those three probes.

- [ ] External benchmark proof remains pending under the benchmark-isolation track. The historical temp `SDL_GRAPH_DB_PATH` run completes but fails 3/10 thresholds on repo scip-io — `quality.edgesPerSymbol` 0.553 (min 1), `quality.graphConnectivity` 24.6% (min 30%), `performance.sliceBuildTimeMs` 465.7ms (max 350ms) — plus a baseline-mismatch warning (`.benchmark/baseline.json` is for another repo/format). Do not claim green without a persisted isolated artifact.

## Chunk 3 Smoke Test Round (2026-07-07, post server restart)

- [x] `file.read` untargeted-read `hint`: VERIFIED live (whole-file read of `templates/SDL.md` returned the exact static hint string).
- [x] Catalog `estTokens`: VERIFIED live (`sdl.action.search` with `includeSchemas` returned `estTokens: 150` for symbol.search and `estTokens: 50` for symbol.getCard through the compact model projection).
- [x] Answer-first: ACTIVE live (explain task with `options.answerFirst: true` returned a composed compact answer). Smoke exposed a projection defect: `projectContextResultForModel` in `src/mcp/context-response-projection.ts` dropped `confidence`, `evidence`, `expand`, and `answerFirstFallback` from model content, breaking the evidence-expansion contract. Fixed (fields now copied); regression tests added to `tests/unit/context-response-projection.test.ts`. Requires one more server restart to observe live.
- [x] Short-ID aliases: workflow/gateway path resolves `sN` correctly, but `sdl.retrieve` did NOT — `resolveShortIdAliases` in `src/mcp/request-normalization.ts` recursed only into `options`, not the retrieve-style nested `args`. Fixed (both alias resolution and referenced-id collection now recurse into `args`); regression test added to `tests/unit/request-normalization.test.ts`. Requires server restart to observe live.
- [x] Dedupe refs: VERIFIED live (second `symbol.getCard` returned `{ ref, unchanged: true }`; repeated `sdl.context` returned unchanged refs).
- [x] Runtime savings: VERIFIED live — usage.stats shows runtimeExecute with non-zero saved tokens (digest savings recorded).
- [x] Signal density gateway-mode gap: FIXED (2026-07-07 follow-up). `extractDeliveredSymbolIdsFromToolResult` in `src/server.ts` now parses full ids from packed `@ids=` dictionary lines (search results and `_packedPayload`), and recurses into `sdl.workflow` `{ fn, result }` step envelopes; `deliveredTokenCount` guard confirmed populated for wrapper tools via `_tokenUsage`. New tests: `tests/unit/delivered-symbol-ids.test.ts` (packed parsing, envelope unwrapping, unchanged-ref skip, end-to-end signalDensity in usage.stats). Gates: lint (0 errors), full `npm test` 597/597 exit 0. Live `Signal density` line still needs a server restart on the new dist.
- [x] Post-fix gates: `npm run build`, `npm run typecheck`, focused unit tests (54 pass / 0 fail), and full `npm test` (596/596 files, exit 0) all green on the working tree containing both fixes.
