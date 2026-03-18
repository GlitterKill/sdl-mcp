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
    const fnEnd = source.indexOf(
      "export async function rerankByEmbeddings(",
      fnStart,
    );
    assert.ok(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart);

    const fnBody = source.slice(fnStart, fnEnd);
    const cardHashIdx = fnBody.indexOf(
      "const cardHash = buildCardHash(symbol, text);",
    );
    const existingIdx = fnBody.indexOf(
      "const existing = await ladybugDb.getSymbolEmbedding(conn, symbol.symbolId);",
    );
    const storageModelIdx = fnBody.indexOf("let storageModel =");
    const storageModelCheckIdx = fnBody.indexOf("existing.model === storageModel");
    const embedIdx = fnBody.indexOf("const [vector] = await provider.embed([text]);");

    assert.ok(
      cardHashIdx !== -1 &&
        existingIdx !== -1 &&
        storageModelIdx !== -1 &&
        storageModelCheckIdx !== -1 &&
        embedIdx !== -1,
      "refreshSymbolEmbeddings should compute cardHash, read cache, derive storageModel, and embed text",
    );
    assert.ok(
      existingIdx > cardHashIdx,
      "refreshSymbolEmbeddings should read cached embedding after cardHash is computed",
    );
    assert.ok(
      storageModelIdx > existingIdx && storageModelIdx < embedIdx,
      "refreshSymbolEmbeddings should derive storageModel before embedding",
    );
    assert.ok(
      storageModelCheckIdx > existingIdx && storageModelCheckIdx < embedIdx,
      "refreshSymbolEmbeddings should check cache using storageModel before embedding",
    );
    assert.ok(
      embedIdx > existingIdx,
      "refreshSymbolEmbeddings should only embed after cache comparison",
    );

    assert.match(
      fnBody,
      /if\s*\(\s*existing\s*&&\s*existing\.model === storageModel\s*&&\s*existing\.cardHash === cardHash\s*\)\s*\{\s*skipped \+= 1;\s*continue;\s*\}/s,
      "refreshSymbolEmbeddings should skip unchanged symbols before embedding work",
    );
  });

  it("does not gate semantic reranking on pre-existing embedding row count", () => {
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
      /rerankByEmbeddings\(\{/,
      "handleSymbolSearch should still call rerankByEmbeddings for semantic requests",
    );
    assert.doesNotMatch(
      fnBody,
      /embeddingCount\s*>\s*0/,
      "handleSymbolSearch should allow semantic reranking to warm a cold embedding cache",
    );
  });

  it("preserves overlay lexical positions when semantic reranking is partial", () => {
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
      /const rerankableSymbolIds = new Set/,
      "handleSymbolSearch should track rerankable lexical slots",
    );
    // New behavior: reranked items come first in semantic relevance order,
    // then non-rerankable items in original lexical order
    assert.match(
      fnBody,
      /\.\.\.rerankedResults/,
      "handleSymbolSearch should place reranked results first",
    );
    assert.match(
      fnBody,
      /!rerankableSymbolIds\.has\(row\.symbolId\)/,
      "handleSymbolSearch should filter out rerankable symbols from the non-reranked tail",
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
