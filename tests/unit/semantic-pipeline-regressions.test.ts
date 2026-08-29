import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("semantic pipeline regressions", () => {
  it("checks embedding cache before invoking provider embed (batched)", () => {
    const source = readSource("src/indexer/embeddings.ts");
    const fnStart = source.indexOf(
      "export async function refreshSymbolEmbeddings(",
    );
    const nextFnStart = source.indexOf("\nexport ", fnStart + 1);
    const fnEnd = nextFnStart !== -1 ? nextFnStart : source.length;
    assert.ok(fnStart !== -1);

    const fnBody = source.slice(fnStart, fnEnd);

    // Phase 4: Batched refresh patterns
    // 1. storageModel pinned once at start (const, not let)
    const storageModelIdx = fnBody.indexOf(
      "const storageModel = provider.isMockFallback",
    );
    assert.ok(
      storageModelIdx !== -1,
      "refreshSymbolEmbeddings should pin storageModel once at start",
    );

    // 2. Pre-pass batch load of existing embeddings
    const prePassIdx = fnBody.indexOf("getSymbolVectorEmbeddings");
    assert.ok(
      prePassIdx !== -1,
      "refreshSymbolEmbeddings should use batch getSymbolVectorEmbeddings",
    );

    // 3. cardHash computed per symbol in uncached filter loop
    const cardHashIdx = fnBody.indexOf(
      "const cardHash = buildCardHash(\n      symbol,\n      prefixedText,\n      jinaCacheCompatibilityKey,\n    )",
    );
    assert.ok(
      cardHashIdx !== -1,
      "refreshSymbolEmbeddings should compute cardHash for each symbol",
    );

    // 4. Batch embed call
    const batchEmbedIdx = fnBody.indexOf(
      "await measureInference(() => provider.embed(batchTexts))",
    );
    assert.ok(
      batchEmbedIdx !== -1,
      "refreshSymbolEmbeddings should batch embed calls",
    );

    // 5. Post-embed recheck for race avoidance
    const postEmbedIdx = fnBody.indexOf("postEmbedExisting");
    assert.ok(
      postEmbedIdx !== -1,
      "refreshSymbolEmbeddings should recheck cache after embed for race avoidance",
    );

    // Order checks: pre-pass before batch embed, batch embed before post-check
    assert.ok(
      prePassIdx < batchEmbedIdx,
      "pre-pass cache load should occur before batch embed",
    );
    assert.ok(
      batchEmbedIdx < postEmbedIdx,
      "batch embed should occur before post-embed recheck",
    );

    // Cache hit skip pattern in uncached filter loop
    assert.match(
      fnBody,
      /if\s*\(\s*existing\s*&&\s*existing\.cardHash === cardHash\s*\)/s,
      "refreshSymbolEmbeddings should skip cached symbols before batching",
    );

    // Batch size source: either the legacy `REFRESH_BATCH_SIZE` constant
    // (kept as an exported alias) or the resolved `batchSize` local that
    // clamps the new `params.batchSize` field against
    // `DEFAULT_EMBEDDING_BATCH_SIZE` / `MAX_EMBEDDING_BATCH_SIZE`.
    assert.match(
      fnBody,
      /REFRESH_BATCH_SIZE|DEFAULT_EMBEDDING_BATCH_SIZE/,
      "refreshSymbolEmbeddings should reference the batch-size constants",
    );
  });

  it("retains Symbol HNSW for bounded writes and rebuilds bulk changes", () => {
    const symbolSource = readSource("src/indexer/embeddings.ts");
    const symbolStart = symbolSource.indexOf(
      "export async function refreshSymbolEmbeddings(",
    );
    const symbolEnd = symbolSource.indexOf("\nexport ", symbolStart + 1);
    assert.ok(symbolStart !== -1);
    const symbolBody = symbolSource.slice(
      symbolStart,
      symbolEnd === -1 ? symbolSource.length : symbolEnd,
    );

    assert.match(
      symbolBody,
      /dropVectorIndex\(\s*wConn,\s*SYMBOL_VECTOR_EMBEDDING_TABLE,\s*indexName/s,
      "bulk Symbol embedding refresh must remove the shared-table HNSW before writes",
    );
    assert.match(
      symbolBody,
      /symbol-vector-rebuild-pre-drop[\s\S]*symbol-vector-rebuild-post-create/,
      "Symbol embedding refresh must checkpoint the drop/write/recreate cycle",
    );
    assert.match(
      symbolBody,
      /dropResult\.status === "failed"[\s\S]*throw new IndexError/,
      "Symbol embedding refresh must fail before writes when HNSW drop fails",
    );
    assert.doesNotMatch(
      symbolBody,
      /rebuildMinUncachedRows|SYMBOL_VECTOR_REBUILD_MIN_ROWS/,
      "the bounded lane must persist rather than defer changed Symbol vectors",
    );
    assert.match(
      symbolSource,
      /const SYMBOL_VECTOR_RETAINED_HNSW_MAX_ROWS = 50;/,
      "the retained-HNSW ceiling must stay pinned to the verified 50-row write",
    );
    assert.match(
      symbolBody,
      /uncachedItems\.length <= SYMBOL_VECTOR_RETAINED_HNSW_MAX_ROWS/,
      "bounded Symbol changes must retain the live HNSW",
    );
    assert.match(
      symbolBody,
      /uncachedItems\.length > SYMBOL_VECTOR_RETAINED_HNSW_MAX_ROWS/,
      "larger Symbol changes must use the bulk rebuild path",
    );
  });

  it("fails refresh when a required Symbol HNSW bootstrap fails", () => {
    const source = readSource("src/indexer/embeddings.ts");
    const createStart = source.indexOf(
      "const createRequiredVectorIndex = async (): Promise<void> =>",
    );
    const createEnd = source.indexOf(
      "const bootstrapVectorIndex = async (): Promise<void> =>",
      createStart,
    );
    const createBody = source.slice(createStart, createEnd);

    assert.match(createBody, /if \(!ok\)[\s\S]*throw new IndexError/);
  });

  it("runs semantic rebuilds outside ambient indexer sessions", () => {
    const indexer = readSource("src/indexer/indexer.ts");
    const metricsUpdater = readSource("src/indexer/metrics-updater.ts");
    const mainFinalize = indexer.indexOf(
      'const finalizeResult = await measurePhase("finalizeIndexing"',
      indexer.indexOf("const sessionEdgeTotal"),
    );
    const mainTailSession = indexer.indexOf(
      "const phaseOutcome = await withPostIndexWriteSession(",
      mainFinalize,
    );
    assert.ok(mainFinalize !== -1 && mainFinalize < mainTailSession);
    assert.doesNotMatch(
      indexer.slice(
        indexer.indexOf("const semanticRefresh = await"),
        indexer.indexOf("return {", indexer.indexOf("const semanticRefresh = await")),
      ),
      /withPostIndexWriteSession/,
    );

    const nonSemanticSession = metricsUpdater.indexOf(
      "const metricsResult = await withPostIndexWriteSession(",
    );
    const semanticRefresh = metricsUpdater.indexOf(
      "if (shouldRunSemanticRefresh && !semanticDeferred)",
    );
    assert.ok(
      nonSemanticSession !== -1 && nonSemanticSession < semanticRefresh,
      "metrics and summaries stay session-serialized before semantic model cycles",
    );
  });
  it("uses the unified retrieval path instead of a legacy rerank", () => {
    const source = readSource("src/mcp/tools/symbol.ts");
    const fnStart = source.indexOf("export async function handleSymbolSearch(");
    const fnEnd = source.indexOf(
      "export async function handleSymbolGetCard(",
      fnStart,
    );
    assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart);

    const fnBody = source.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /searchSymbolsHybridWithOverlay/,
      "handleSymbolSearch should use hybrid search",
    );
    assert.match(
      fnBody,
      /useUnifiedRetrieval/,
      "handleSymbolSearch should select the unified retrieval path",
    );
    assert.doesNotMatch(fnBody, /useHybrid|shouldFallbackToLegacy/);
  });

  it("hybrid search handles overlay and durable results", () => {
    const source = readSource("src/mcp/tools/symbol.ts");
    const fnStart = source.indexOf("export async function handleSymbolSearch(");
    const fnEnd = source.indexOf(
      "export async function handleSymbolGetCard(",
      fnStart,
    );
    assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart);

    const fnBody = source.slice(fnStart, fnEnd);
    assert.match(
      fnBody,
      /searchSymbolsWithOverlay/,
      "handleSymbolSearch should retain explicit lexical overlay search",
    );
    assert.match(
      fnBody,
      /searchSymbolsHybridWithOverlay/,
      "handleSymbolSearch should use hybrid overlay search for hybrid path",
    );
  });

  it("marks semantic readiness dirty when provider-first reuses active rows", () => {
    const source = readSource("src/indexer/indexer.ts");
    const branchStart = source.indexOf(
      '"Provider-first SCIP active rows reused"',
    );
    assert.ok(branchStart !== -1);
    const branchEnd = source.indexOf(
      "const versionId = await createOrReuseVersion",
      branchStart,
    );
    assert.ok(branchEnd !== -1 && branchEnd > branchStart);

    const branchBody = source.slice(branchStart, branchEnd);
    assert.match(
      branchBody,
      /markProviderFirstSemanticReadinessDeferred/,
      "provider-first active row reuse must persist semantic deferred dirty flags",
    );
    assert.match(
      branchBody,
      /semanticDeferred/,
      "provider-first active row reuse must report semantic deferral from the helper result",
    );
  });

  it("runs semantic readiness refresh after provider-first graph activation", () => {
    const source = readSource("src/indexer/indexer.ts");
    assert.match(
      source,
      /runProviderFirstSemanticReadinessRefresh/,
      "provider-first indexing should run a post-activation semantic refresh against the active DB",
    );
    assert.match(
      source,
      /semanticDeferred\s*=\s*semanticRefresh\.semanticDeferred/,
      "provider-first result should only remain deferred when semantic refresh does not complete",
    );
  });

  it("hybrid symbol search uses the same external-filter boundary as lexical search", () => {
    const symbolSource = readSource("src/mcp/tools/symbol.ts");
    const handleStart = symbolSource.indexOf(
      "export async function handleSymbolSearch(",
    );
    const handleEnd = symbolSource.indexOf(
      "export async function handleSymbolGetCard(",
      handleStart,
    );
    assert.ok(
      handleStart !== -1 && handleEnd !== -1 && handleEnd > handleStart,
    );
    const handleBody = symbolSource.slice(handleStart, handleEnd);

    assert.match(
      handleBody,
      /excludeExternal:\s*request\.excludeExternal/,
      "handleSymbolSearch should pass excludeExternal into the hybrid path",
    );
    assert.match(
      handleBody,
      /findSymbolByExactName\([\s\S]*request\.excludeExternal/,
      "exact-name fallback should use the same excludeExternal request boundary",
    );

    const overlaySource = readSource("src/live-index/overlay-reader.ts");
    const hybridStart = overlaySource.indexOf(
      "export async function searchSymbolsHybridWithOverlay",
    );
    assert.ok(hybridStart !== -1);
    const hybridBody = overlaySource.slice(hybridStart);
    assert.match(
      hybridBody,
      /getSearchableSymbolsByIds\([\s\S]*hybridOptions\.excludeExternal/,
      "hybrid hydration should filter to searchable symbols before returning MCP rows",
    );
  });

  it("keeps local summary provider model optional so default fallback model is used", () => {
    const source = readSource("src/indexer/summary-generator.ts");
    const fnStart = source.indexOf("export function createSummaryProvider(");
    const fnEnd = source.indexOf(
      "export async function generateSummaryWithGuardrails(",
      fnStart,
    );
    assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart);

    const fnBody = source.slice(fnStart, fnEnd);
    const localStart = fnBody.indexOf('if (provider === "local") {');
    assert.ok(
      localStart !== -1,
      "createSummaryProvider should include a local provider branch",
    );

    const localBranch = fnBody.slice(localStart);
    assert.match(
      localBranch,
      /new OpenAICompatibleSummaryProvider\(\{/,
      "local provider branch should construct OpenAICompatibleSummaryProvider",
    );
    assert.match(
      localBranch,
      /model:\s*options\?\.summaryModel/,
      "local provider should pass optional summaryModel and rely on provider default when unset",
    );
    assert.doesNotMatch(
      localBranch,
      /if\s*\(\s*!options\?\.summaryModel\s*\)\s*\{[\s\S]*?return null;\s*\}/,
      "local provider should not skip summary generation when summaryModel is omitted",
    );
  });

  it("does not let mock summaries overwrite LLM summaries", () => {
    const source = readSource("src/indexer/summary-generator.ts");
    const fnStart = source.indexOf("export async function generateSummariesForRepo(");
    assert.ok(fnStart !== -1);
    const fnBody = source.slice(fnStart);
    const llmSkipIdx = fnBody.indexOf(
      'isMockProvider && sym.summarySource === "llm"',
    );
    const enqueueIdx = fnBody.indexOf("needsSummary.push(sym)");

    assert.ok(
      llmSkipIdx !== -1,
      "mock summary generation should skip existing LLM-authored summaries",
    );
    assert.ok(
      enqueueIdx !== -1 && llmSkipIdx < enqueueIdx,
      "LLM-authored summaries must be filtered before mock generation is queued",
    );
  });

  it("limits mock summary cache hash to deterministic prose inputs", () => {
    const source = readSource("src/indexer/summary-generator.ts");
    const fnStart = source.indexOf("function buildSummaryCardHash(");
    assert.ok(fnStart !== -1);
    const fnEnd = source.indexOf("function summaryStorageMetadata", fnStart);
    assert.ok(fnEnd !== -1 && fnEnd > fnStart);
    const fnBody = source.slice(fnStart, fnEnd);
    const mockBranchStart = fnBody.indexOf('input.providerName === "mock"');
    const nonMockAstHashIdx = fnBody.indexOf("input.astFingerprint", mockBranchStart);
    assert.ok(mockBranchStart !== -1);
    assert.ok(nonMockAstHashIdx !== -1 && nonMockAstHashIdx > mockBranchStart);

    const mockBranch = fnBody.slice(mockBranchStart, nonMockAstHashIdx);
    assert.doesNotMatch(
      mockBranch,
      /astFingerprint/,
      "mock summary hash should not change for body-only AST updates",
    );
    assert.match(
      mockBranch,
      /CONCISE_SYMBOL_SUMMARY_BUILDER_VERSION[\s\S]*signatureText[\s\S]*roleTags[\s\S]*sideEffects/,
      "mock summary hash should include only output-affecting prose builder inputs",
    );

  });

  it("batch summary generation avoids standalone cache reads and transactional split writes", () => {
    const source = readSource("src/indexer/summary-generator.ts");
    const fnStart = source.indexOf("export async function generateSummariesForRepo(");
    assert.ok(fnStart !== -1);
    const fnBody = source.slice(fnStart);

    assert.doesNotMatch(
      fnBody,
      /getSummaryCache\(/,
      "batch generation should rely on the bulk getSummaryCaches snapshot",
    );
    assert.match(fnBody, /skipCacheLookup:\s*true/);
    assert.match(fnBody, /persistCache:\s*false/);
    assert.match(
      fnBody,
      /persistGeneratedSummariesInTransaction\(generatedRows\)/,
      "batch generation should persist cache and Symbol summary rows together",
    );
  });

  it("initializes embedding providers before persistence prepasses and keeps post-embed mock guards", () => {
    const symbolSource = readSource("src/indexer/embeddings.ts");
    const symbolStart = symbolSource.indexOf(
      "export async function refreshSymbolEmbeddings(",
    );
    const symbolEnd = symbolSource.indexOf("\nexport ", symbolStart + 1);
    const symbolBody = symbolSource.slice(
      symbolStart,
      symbolEnd === -1 ? symbolSource.length : symbolEnd,
    );
    const symbolInitialize = symbolBody.indexOf("await provider.initialize?.()");
    const symbolCompatibilityKey = symbolBody.indexOf(
      "provider.getCacheCompatibilityKey?.()",
    );
    const symbolConnection = symbolBody.indexOf("await getLadybugConn()");
    const symbolCachePrepass = symbolBody.indexOf("getSymbolVectorEmbeddings(");
    const symbolHashPrepass = symbolBody.indexOf(
      "buildCardHash(\n      symbol,\n      prefixedText,\n      jinaCacheCompatibilityKey,\n    )",
    );

    assert.ok(
      symbolInitialize !== -1 && symbolInitialize < symbolConnection,
      "Symbol provider must initialize before LadybugDB opens",
    );
    assert.ok(
      symbolInitialize < symbolCompatibilityKey &&
        symbolCompatibilityKey < symbolHashPrepass &&
        symbolInitialize < symbolCachePrepass &&
        symbolInitialize < symbolHashPrepass,
      "Symbol provider must settle its compatibility key before cache hashing",
    );
    assert.strictEqual(
      (symbolBody.match(/provider\.getCacheCompatibilityKey\?\.\(\)/g) ?? [])
        .length,
      1,
      "Symbol persistence must capture the settled compatibility key once",
    );
    assert.match(
      symbolBody,
      /storageModel === "jina-embeddings-v2-base-code"[\s\S]*provider\.getCacheCompatibilityKey\?\.\(\)[\s\S]*buildCardHash\([\s\S]*jinaCacheCompatibilityKey/,
      "Symbol persistence must pass the settled Jina key into its hash",
    );
    assert.doesNotMatch(
      symbolBody,
      /model_fp16\.onnx/,
      "Symbol persistence must not assume FP16 before initialization",
    );
    assert.match(
      symbolBody,
      /provider\.embed\(batchTexts\)[\s\S]*provider\.isMockFallback\?\.\(\)/,
      "Symbol persistence must retain its post-embed mock guard",
    );

    const fileSource = readSource("src/indexer/file-summary-embeddings.ts");
    const fileStart = fileSource.indexOf(
      "export async function refreshFileSummaryEmbeddings(",
    );
    const fileEnd = fileSource.indexOf("\nexport ", fileStart + 1);
    const fileBody = fileSource.slice(
      fileStart,
      fileEnd === -1 ? fileSource.length : fileEnd,
    );
    const fileInitialize = fileBody.indexOf("await provider.initialize?.()");
    const fileCompatibilityKey = fileBody.indexOf(
      "provider.getCacheCompatibilityKey?.()",
    );
    const fileConnection = fileBody.indexOf("await getLadybugConn()");
    const fileCachePrepass = fileBody.indexOf("inspectSummaries(summaries)");
    const fileHashPrepass = fileBody.indexOf(
      "hashEmbeddingPayload(\n        [summary.fileId, prefixedText],\n        jinaCacheCompatibilityKey,\n      )",
    );

    assert.ok(
      fileInitialize !== -1 && fileInitialize < fileConnection,
      "FileSummary provider must initialize before LadybugDB opens",
    );
    assert.ok(
      fileInitialize < fileCompatibilityKey &&
        fileCompatibilityKey < fileHashPrepass &&
        fileInitialize < fileCachePrepass &&
        fileInitialize < fileHashPrepass,
      "FileSummary provider must settle its compatibility key before cache hashing",
    );
    assert.strictEqual(
      (fileBody.match(/provider\.getCacheCompatibilityKey\?\.\(\)/g) ?? [])
        .length,
      1,
      "FileSummary persistence must capture the settled compatibility key once",
    );
    assert.match(
      fileBody,
      /storageModel === "jina-embeddings-v2-base-code"[\s\S]*provider\.getCacheCompatibilityKey\?\.\(\)[\s\S]*hashEmbeddingPayload\([\s\S]*jinaCacheCompatibilityKey/,
      "FileSummary persistence must pass the settled Jina key into its hash",
    );
    assert.doesNotMatch(
      fileBody,
      /model_fp16\.onnx/,
      "FileSummary persistence must not assume FP16 before initialization",
    );
    assert.match(
      fileSource,
      /const vectors = await provider\.embed\([\s\S]*provider\.isMockFallback\?\.\(\)/,
      "FileSummary persistence must retain its post-embed mock guard",
    );
  });


});
