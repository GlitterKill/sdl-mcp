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
    const prePassIdx = fnBody.indexOf("getSymbolEmbeddingsFromNodes");
    assert.ok(
      prePassIdx !== -1,
      "refreshSymbolEmbeddings should use batch getSymbolEmbeddingsFromNodes",
    );

    // 3. cardHash computed per symbol in uncached filter loop
    const cardHashIdx = fnBody.indexOf(
      "const cardHash = buildCardHash(symbol, prefixedText)",
    );
    assert.ok(
      cardHashIdx !== -1,
      "refreshSymbolEmbeddings should compute cardHash for each symbol",
    );

    // 4. Batch embed call
    const batchEmbedIdx = fnBody.indexOf("await provider.embed(batchTexts)");
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

  it("uses hybrid search path instead of legacy rerank", () => {
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
      /useHybrid/,
      "handleSymbolSearch should have useHybrid flag",
    );
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
      "handleSymbolSearch should use overlay search for legacy path",
    );
    assert.match(
      fnBody,
      /searchSymbolsHybridWithOverlay/,
      "handleSymbolSearch should use hybrid overlay search for hybrid path",
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
});
