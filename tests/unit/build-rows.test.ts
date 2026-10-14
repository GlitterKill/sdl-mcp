import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BuildRowsParams } from "../../src/indexer/parser/types.js";

const TEST_CONTENT = [
  'describe("registration   contract", () => {});',
  'it.only("keeps sdl.info callable", () => {});',
  "export function helper() {}",
].join("\n");

function detail(
  nodeId: string,
  kind: BuildRowsParams["symbolDetails"][number]["extractedSymbol"]["kind"] =
    "function",
  startLine = 1,
): BuildRowsParams["symbolDetails"][number] {
  return {
    extractedSymbol: {
      nodeId,
      kind,
      name: nodeId,
      exported: true,
      range: {
        startLine,
        startCol: 0,
        endLine: startLine,
        endCol: 1,
      },
    },
    astFingerprint: nodeId,
    symbolId: `sym:${nodeId}`,
  };
}

function testBuildRowsParams(
  symbolDetails: BuildRowsParams["symbolDetails"] = [
    detail("module", "module"),
    detail("helper"),
  ],
  content = TEST_CONTENT,
  languageId = "typescript",
): BuildRowsParams {
  const extension =
    languageId === "csharp" ? "cs" : languageId === "rust" ? "rs" : "ts";
  const relPath =
    languageId === "typescript"
      ? "tests/unit/sample.test.ts"
      : `src/sample.${extension}`;
  const nameToSymbolIds = new Map<string, string[]>();
  for (const symbolDetail of symbolDetails) {
    nameToSymbolIds.set(symbolDetail.extractedSymbol.name, [
      symbolDetail.symbolId,
    ]);
  }

  return {
    repoId: "test-repo",
    relPath,
    fileId: "test-file",
    filePath: relPath,
    content,
    ext: extension,
    languages: languageId === "typescript" ? ["ts"] : [languageId],
    symbolDetails,
    nodeIdToSymbolId: new Map(
      symbolDetails.map((symbolDetail) => [
        symbolDetail.extractedSymbol.nodeId,
        symbolDetail.symbolId,
      ]),
    ),
    nameToSymbolIds,
    existingSymbolsById: new Map(),
    importResolution: {
      targets: [],
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
    },
    calls: [],
    edgeSourceNodeIds: new Set(),
    languageId,
    skipCallResolution: true,
  };
}

describe("buildSymbolAndEdgeRows import fanout", () => {
  it("collapses high-fanout C++ pass-1 imports to module symbols", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: new Set(["module", "fn1", "fn2"]),
      importTargetCount: 200,
      languageId: "cpp",
      skipCallResolution: true,
    });

    assert.deepEqual(Array.from(selected), ["module"]);
  });

  it("keeps ordinary non-C++ import fanout unchanged", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const sourceIds = new Set(["module", "fn1", "fn2"]);
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: sourceIds,
      importTargetCount: 200,
      languageId: "typescript",
      skipCallResolution: true,
    });

    assert.equal(selected, sourceIds);
  });

  it("keeps module search text canonical for fallback and native rows", async () => {
    const { buildSymbolAndEdgeRows } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const fallbackParams = testBuildRowsParams();
    const fallback = await buildSymbolAndEdgeRows(fallbackParams);
    const fallbackModule = fallback.symbolsToUpsert.find(
      (symbol) => symbol.kind === "module",
    );
    const fallbackFunction = fallback.symbolsToUpsert.find(
      (symbol) => symbol.kind === "function",
    );

    assert.ok(fallbackModule);
    assert.ok(fallbackFunction);
    const nativeParams = testBuildRowsParams(
      fallbackParams.symbolDetails.map((symbolDetail) =>
        symbolDetail.extractedSymbol.kind === "module"
          ? {
              ...symbolDetail,
              nativeSearchText: fallbackModule.searchText,
            }
          : symbolDetail,
      ),
    );
    const native = await buildSymbolAndEdgeRows(nativeParams);
    const nativeModule = native.symbolsToUpsert.find(
      (symbol) => symbol.kind === "module",
    );
    const nativeFunction = native.symbolsToUpsert.find(
      (symbol) => symbol.kind === "function",
    );

    assert.ok(nativeModule);
    assert.ok(nativeFunction);
    for (const module of [fallbackModule, nativeModule]) {
      assert.equal(module.searchText.includes("registration contract"), false);
      assert.equal(module.searchText.includes("keeps sdl.info callable"), false);
    }
    assert.equal(nativeModule.searchText, fallbackModule.searchText);
    assert.equal(nativeFunction.searchText, fallbackFunction.searchText);
    assert.deepEqual(
      native.symbolsToUpsert.map((symbol) => symbol.symbolId),
      fallback.symbolsToUpsert.map((symbol) => symbol.symbolId),
    );
    assert.deepEqual(native.edgesToInsert, fallback.edgesToInsert);

    const withoutModule = await buildSymbolAndEdgeRows(
      testBuildRowsParams([detail("helper")]),
    );
    assert.equal(withoutModule.symbolsToUpsert.length, 1);
    assert.equal(
      withoutModule.symbolsToUpsert[0]?.searchText,
      fallbackFunction.searchText,
    );
  });
});

describe("buildSymbolAndEdgeRows documentation summaries", () => {
  it("uses C# XML summaries for row text and quality without leaking docs to a sibling", async () => {
    const { buildSymbolAndEdgeRows } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const content = [
      "class Cache {",
      "  /// <summary>",
      '  /// Loads a value from <see cref="T:CacheStore"/> at <paramref name="path"/> &amp;',
      '  /// returns the matching &lt;entry&gt; named &quot;primary&quot;',
      "  /// &apos;cache&apos; &#39;value&#39;.",
      "  /// </summary>",
      "  public object Load(string path) => null;",
      "  public void Clear() {}",
      "}",
    ].join("\r\n");
    const params = testBuildRowsParams(
      [detail("Load", "method", 7), detail("Clear", "method", 8)],
      content,
      "csharp",
    );
    params.existingSymbolsById.set("sym:Load", {
      symbolId: "sym:Load",
      repoId: "test-repo",
      fileId: "test-file",
      kind: "method",
      name: "Load",
      exported: true,
      visibility: null,
      language: "csharp",
      rangeStartLine: 7,
      rangeStartCol: 0,
      rangeEndLine: 7,
      rangeEndCol: 1,
      astFingerprint: "Load",
      signatureJson: null,
      summary: "Previously cached heuristic summary.",
      invariantsJson: null,
      sideEffectsJson: null,
      summaryQuality: 0.4,
      summarySource: "heuristic-typed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await buildSymbolAndEdgeRows(params);
    const load = result.symbolsToUpsert.find((symbol) => symbol.name === "Load");
    const clear = result.symbolsToUpsert.find((symbol) => symbol.name === "Clear");

    assert.ok(load);
    const expectedSummary = [
      "Loads a value from CacheStore at path & returns the matching <entry>",
      'named "primary" \'cache\' \'value\'',
    ].join(" ");
    assert.equal(
      load.summary,
      expectedSummary,
    );
    assert.equal(load.summarySource, "jsdoc");
    assert.equal(load.summaryQuality, 1);
    assert.ok(clear);
    assert.notEqual(clear.summarySource, "jsdoc");
    assert.ok(!clear.summary?.includes("CacheStore"));
  });

  it("does not treat Rust module inner docs as symbol documentation", async () => {
    const { buildSymbolAndEdgeRows } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const content = "//! Module documentation.\n\nfn helper() {}";
    const result = await buildSymbolAndEdgeRows(
      testBuildRowsParams([detail("helper", "function", 3)], content, "rust"),
    );
    const helper = result.symbolsToUpsert[0];

    assert.ok(helper);
    assert.notEqual(helper.summarySource, "jsdoc");
    assert.ok(!helper.summary?.includes("Module documentation"));
  });
});
