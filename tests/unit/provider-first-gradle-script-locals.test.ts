import { it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument } from "../../dist/scip/types.js";

const document = (
  relativePath: string,
  name: string,
  kind = 26,
): ScipDocument => ({
  relativePath,
  language: "kotlin",
  symbols: [
    {
      symbol: "local 0",
      displayName: name,
      kind,
      documentation: [],
      relationships: [],
    },
  ],
  occurrences: [
    {
      symbol: "local 0",
      range: { startLine: 0, startCol: 4, endLine: 0, endCol: 4 + name.length },
      symbolRoles: 1,
      diagnostics: [],
      overrideDocumentation: [],
      syntaxKind: 0,
    },
    {
      symbol: "local 0",
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: name.length },
      symbolRoles: 0,
      diagnostics: [],
      overrideDocumentation: [],
      syntaxKind: 0,
    },
  ],
});
const normalize = (docs: ScipDocument[], sources: Map<string, string>) =>
  normalizeScipProviderFacts({
    repoId: "scripts",
    generationId: "test",
    providerId: "scip-java",
    documents: docs,
    sourceTextByPath: sources,
  });

it("materializes typed compiler script locals and keeps identical local IDs document-scoped", () => {
  const docs = [
    document("build.gradle.kts", "first"),
    document("child/build.gradle.kts", "other"),
  ];
  const sources = new Map(
    docs.map((d, i) => [
      d.relativePath,
      i ? "fun other() {}\nother()" : "fun first() {}\nfirst()",
    ]),
  );
  for (const ordered of [docs, [...docs].reverse()]) {
    const facts = normalize(ordered, sources);
    assert.equal(facts.symbols.length, 2);
    assert.equal(new Set(facts.symbols.map((s) => s.symbolId)).size, 2);
    for (const symbol of facts.symbols) {
      assert.equal(symbol.symbolKind, "function");
      assert.equal(
        facts.occurrences.find(
          (o) => o.relPath === symbol.relPath && o.role !== "definition",
        )?.symbolId,
        symbol.symbolId,
      );
      const coverage = facts.coverage.find(
        (c) => c.relPath === symbol.relPath,
      )!;
      assert.equal(coverage.legacyFallback, "skip");
      assert.equal(coverage.callProofUnavailableReferences, 0);
    }
  }
});

it("does not accept untyped locals, metadata-only locals, wrong definition text or ordinary Kotlin locals", () => {
  for (const mode of ["untyped", "metadata", "wrong-name", "ordinary"]) {
    const doc = document(
      mode === "ordinary" ? "Source.kt" : "build.gradle.kts",
      "first",
      mode === "untyped" ? 0 : 26,
    );
    if (mode === "metadata")
      doc.occurrences = doc.occurrences.filter((o) => o.symbolRoles === 0);
    const facts = normalize(
      [doc],
      new Map([
        [
          doc.relativePath,
          mode === "wrong-name"
            ? "fun other() {}\nfirst()"
            : "fun first() {}\nfirst()",
        ],
      ]),
    );
    assert.equal(facts.symbols.length, 0, mode);
    assert.equal(facts.coverage[0]!.legacyFallback, "full", mode);
  }
});

it("retains call-proof failure for wrong reference text and never resolves another document's local", () => {
  const defined = document("build.gradle.kts", "first");
  const reference = document("child/build.gradle.kts", "first");
  reference.symbols = [];
  reference.occurrences = reference.occurrences.filter(
    (o) => o.symbolRoles === 0,
  );
  const facts = normalize(
    [defined, reference],
    new Map([
      [defined.relativePath, "fun first() {}\nother()"],
      [reference.relativePath, "\nfirst()"],
    ]),
  );
  assert.equal(facts.coverage[0]!.callProofUnavailableReferences, 1);
  assert.equal(
    facts.occurrences.find((o) => o.relPath === reference.relativePath)
      ?.symbolId,
    undefined,
  );
});

it("materializes a compiler-typed script variable without inventing its kind from local ID text", () => {
  const doc = document("build.gradle.kts", "value", 61);
  const facts = normalize(
    [doc],
    new Map([[doc.relativePath, "val value = 1\nvalue"]]),
  );
  assert.equal(facts.symbols[0]?.symbolKind, "variable");
  assert.equal(facts.coverage[0]?.legacyFallback, "skip");
});
