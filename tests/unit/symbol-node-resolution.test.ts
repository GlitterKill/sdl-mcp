import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { getAdapterForExtension } from "../../dist/indexer/adapter/registry.js";
import { buildSymbolDetails } from "../../dist/indexer/parser/symbol-mapping.js";
import { resolveSymbolNodeForFingerprint } from "../../dist/indexer/parser/symbol-node-resolution.js";
import { generateAstFingerprint } from "../../dist/indexer/fingerprints.js";

const cases = [
  {
    label: "TypeScript function",
    extension: ".ts",
    filePath: "src/example.ts",
    source: "export function calculate(value: number): number { return value + 1; }\n",
    name: "calculate",
  },
  {
    label: "Python function_definition",
    extension: ".py",
    filePath: "src/example.py",
    source: "def calculate(value: int) -> int:\n    return value + 1\n",
    name: "calculate",
  },
] as const;

describe("resolveSymbolNodeForFingerprint", () => {
  for (const fixture of cases) {
    it(`matches normal indexing for ${fixture.label}`, () => {
      const adapter = getAdapterForExtension(fixture.extension);
      assert.ok(adapter);
      const tree = adapter.parse(fixture.source, fixture.filePath);
      assert.ok(tree);
      const symbol = adapter
        .extractSymbols(tree, fixture.source, fixture.filePath)
        .find((candidate) => candidate.name === fixture.name);
      assert.ok(symbol);

      const node = resolveSymbolNodeForFingerprint(tree, {
        kind: symbol.kind,
        name: symbol.name,
        startLine: symbol.range.startLine,
        startCol: symbol.range.startCol,
      });
      assert.ok(node);

      const [detail] = buildSymbolDetails({
        symbolsWithNodeIds: [symbol],
        tree,
        repoId: "repo",
        fileMeta: { path: fixture.filePath, size: fixture.source.length, mtime: 0 },
      });
      assert.equal(detail?.astFingerprint, generateAstFingerprint(node));
    });
  }

  it("treats prototype-like symbol kinds as unknown instead of object properties", () => {
    const source = readFileSync(
      new URL("../fixtures/kotlin/symbols.kt", import.meta.url),
      "utf8",
    );
    const adapter = getAdapterForExtension(".kt");
    assert.ok(adapter);
    const tree = adapter.parse(source, "src/User.kt");
    assert.ok(tree);
    const constructor = adapter
      .extractSymbols(tree, source, "src/User.kt")
      .find((symbol) => symbol.kind === "constructor");
    assert.ok(constructor);

    assert.doesNotThrow(() =>
      resolveSymbolNodeForFingerprint(tree, {
        kind: constructor.kind,
        name: constructor.name,
        startLine: constructor.range.startLine,
        startCol: constructor.range.startCol,
      }),
    );
  });
});
