import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("semantic pipeline regressions", () => {
  it("checks embedding cache before invoking provider embed", () => {
    const source = readSource("src/indexer/embeddings.ts");
    const fnStart = source.indexOf("export async function refreshSymbolEmbeddings(");
    // refreshSymbolEmbeddings is now the last exported function;
    // use EOF as the end boundary
    const fnEnd = source.length;
    assert.ok(fnStart !== -1);

    const fnBody = source.slice(fnStart, fnEnd);
    const cardHashIdx = fnBody.indexOf(
      "const cardHash = buildCardHash(symbol, prefixedText);",
    );
    const storageModelIdx = fnBody.indexOf("let storageModel =");
    const existingIdx = fnBody.indexOf(
      "const existing = await getSymbolEmbeddingFromNode(conn, symbol.symbolId, storageModel);",
    );
    const embedIdx = fnBody.indexOf("const [vector] = await provider.embed([prefixedText]);");
    const existingAfterEmbedIdx = fnBody.indexOf(
      "const existingAfterEmbed = await getSymbolEmbeddingFromNode(conn, symbol.symbolId, storageModel);",
    );

    assert.ok(
      cardHashIdx !== -1 &&
        existingIdx !== -1 &&
        storageModelIdx !== -1 &&
        embedIdx !== -1 &&
        existingAfterEmbedIdx !== -1,
      "refreshSymbolEmbeddings should compute cardHash, derive storageModel, read cache, and re-check after embedding",
    );
    assert.ok(
      storageModelIdx > cardHashIdx,
      "refreshSymbolEmbeddings should derive storageModel after cardHash is computed",
    );
    assert.ok(
      existingIdx > storageModelIdx && existingIdx < embedIdx,
      "refreshSymbolEmbeddings should read cached embedding after deriving storageModel and before embedding",
    );
    assert.ok(
      existingAfterEmbedIdx > embedIdx,
      "refreshSymbolEmbeddings should re-check storage after embedding in case the provider changed fallback status",
    );
    assert.ok(
      embedIdx > existingIdx,
      "refreshSymbolEmbeddings should only embed after cache comparison",
    );

    assert.match(
      fnBody,
      /if\s*\(\s*existing\s*&&\s*existing\.cardHash === cardHash\s*\)\s*\{\s*skipped \+= 1;\s*continue;\s*\}/s,
      "refreshSymbolEmbeddings should skip unchanged symbols before embedding work",
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
    assert.ok(localStart !== -1, "createSummaryProvider should include a local provider branch");

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
