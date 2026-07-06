# 2026-07-05 Token Economy Status

## Stage 0 Baseline

- [x] `npm run build`: PASS (`runtime-sdl-mcp-1783302845355-650d5d0c3dc92fbd`, exit 0).
- [x] `npm run typecheck`: PASS (`runtime-sdl-mcp-1783302851587-c0b401122276d2e5`, exit 0).
- [x] `npm run lint`: PASS (`runtime-sdl-mcp-1783302876842-076fd030049531f9`, exit 0).
- [x] `npm test`: PASS (`runtime-sdl-mcp-1783303062636-9a76c2f114ae42c2`, exit 0, 177.6s).

## Companion-Plan Audit

- [ ] trim-tool-response-fields Phase 1: NOT SHIPPED.
  Evidence: `src/mcp/tools/code.ts` `handleCodeNeedWindow` still populates approved/downgraded response fields `whyApproved`, `estimatedTokens`, `matchedIdentifiers`, and `matchedLineNumbers`; raw approved path also still emits `whyApproved` and `estimatedTokens`.

- [x] compact agent payload projected response path: SHIPPED.
  Evidence: `src/mcp/context-response-projection.ts` exports `projectToolResultForModelContent`, `projectContextResultForUsageAccounting`, `projectBroadContextResult`, `isBroadContextResult`, and `BROAD_VISIBLE_FIELDS`; `src/server.ts` builds text from `modelPayload = projectToolResultForModelContent(...)` and projects `structuredContent`.

- [x] compact agent payload normal token-savings footer/meter append: SHIPPED.
  Evidence: `src/server.ts` `shouldIncludeDisplayFooter` only allows response footer text for `includeTelemetry: true` or `detail: "full"`; normal responses do not append the savings meter. Per-call savings still goes out as MCP notification via `renderUserNotificationLine`, not as response content.

- [ ] usage.stats formattedSummary text/structured dedupe: NOT SHIPPED.
  Evidence: `src/mcp/context-response-projection.ts` `projectUsageStatsForModel` still copies `formattedSummary`; `src/server.ts` special-cases `sdl.usage.stats` to set `userDisplay = summary`, while `structuredResult` still carries `formattedSummary`.

- [x] symbol.getCard surface trim: SHIPPED.
  Evidence: live `symbolGetCard` for `src/mcp/tools/symbol.ts` `handleSymbolGetCard` omitted `repoId`, `visibility`, `detailLevel`, `version.ledgerVersion`, and `etag`. `src/mcp/context-response-projection.ts` `shouldKeepModelField` drops `repoId` for non-repo tools and drops compact debug fields.

- [ ] symbol.getCard raw builder trim: NOT SHIPPED.
  Evidence: `src/mcp/tools/symbol.ts` `handleSymbolGetCard` returns `{ card: result }` from `buildCardForSymbol`; `src/services/card-builder.ts` `buildCardForSymbol` still constructs `repoId`, `visibility`, `detailLevel`, and `version.ledgerVersion` before projection.

## Stage 3 Search Miss Investigation

- [ ] `queryFts` identifier splitting: NOT SHIPPED before Stage 3.
  Evidence: `src/retrieval/orchestrator.ts` passed `options.query` through `queryFts` directly into `buildFtsStoredProcQuery` without `splitCamelSubwords` or query expansion.

- [x] FTS indexed content includes identifier fragments: SHIPPED.
  Evidence: `src/indexer/symbol-enrichment.ts` `buildSearchText` stores `params.name` plus `splitIdentifierLikeText(params.name)`, summary fragments, path tokens, role tags, and signature terms. No schema or reindex change needed for this stage.

- [ ] legacy overlay subword matching: PARTIAL before Stage 3.
  Evidence: durable legacy search uses `searchSymbolsLite` -> `splitSearchTerms`, which already splits camelCase/PascalCase. The overlay matcher in `src/live-index/overlay-reader.ts` split only whitespace and treated single identifiers as one raw term.
