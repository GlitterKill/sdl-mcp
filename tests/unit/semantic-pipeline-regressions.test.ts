import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8").replace(
    /\r\n?/g,
    "\n",
  );
}

describe("semantic pipeline regressions", () => {
  it("checks repository embedding cache before invoking the initialized provider", () => {
    const source = readSource("src/indexer/embeddings.ts");
    const start = source.indexOf("export async function refreshSymbolEmbeddings(");
    const end = source.indexOf("\nfunction isExpectedRepositoryVectorIndexIdentity", start);
    assert.ok(start !== -1 && end > start);
    const body = source.slice(start, end);
    const initialized = body.indexOf("await provider.initialize?.()");
    const cache = body.indexOf("await getRepoSymbolVectorEmbeddings(");
    const hash = body.indexOf("const cardHash = buildCardHash(");
    const embed = body.indexOf("provider.embed(batch.map");
    assert.ok(initialized >= 0 && initialized < cache);
    assert.ok(cache < hash && hash < embed);
    assert.match(body, /if \(existing\?\.cardHash === cardHash\)/);
    assert.match(body, /provider\.isMockFallback\?\.\(\)[\s\S]*degraded: true/);
    assert.match(body, /DEFAULT_EMBEDDING_BATCH_SIZE/);
    assert.match(body, /await validateRepoSymbolVectorOwnership\([\s\S]*await setRepoSymbolVectorEmbeddingBatch\(/);
    assert.match(body, /assertCompleteRepositoryVectorCoverage/);
  });

  it("reconciles repository HNSW around vector mutations", () => {
    const source = readSource("src/indexer/embeddings.ts");
    assert.match(source, /const plan = planRepositorySymbolVectorReconciliation\(/);
    assert.match(source, /if \(plan\.dropExpectedBeforeMutation\)[\s\S]*dropExpectedRepositoryVectorIndex\(\s*writeConn,\s*identity\.tableName,\s*identity\.indexName/s);
    assert.match(source, /liveHnsw: plan\.retainExpectedIndex/);
    assert.match(source, /resolveRepositorySymbolVectorIndexMode\(postCount\)/);
    assert.match(source, /createVectorIndex\(\s*writeConn,\s*identity\.tableName,\s*identity\.propertyName,\s*identity\.indexName/s);
    assert.match(source, /const result = await dropVectorIndex\(conn, tableName, indexName\);\s*if \(result\.status === "failed"\) \{\s*throw new IndexError/s);
    assert.match(source, /runHnswRebuildCycle\(/);
  });

  it("fails refresh when a required repository HNSW bootstrap fails", () => {
    const source = readSource("src/indexer/embeddings.ts");
    assert.match(source, /if \(!created\) \{\s*throw new IndexError\(\s*`Failed to create required repository vector index/s);
    assert.match(source, /if \(requiredMode === "hnsw"\) \{[\s\S]*await queryVectorIndexProbe\(/);
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
