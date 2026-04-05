import { describe, it } from "node:test";
import assert from "node:assert";
import { createExternalSymbol } from "../../dist/scip/external-symbols.js";
import type { ScipExternalSymbol } from "../../dist/scip/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExternalInfo(
  overrides: Partial<ScipExternalSymbol> & { symbol: string },
): ScipExternalSymbol {
  return {
    documentation: [],
    relationships: [],
    kind: 12, // Function by default
    displayName: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createExternalSymbol
// ---------------------------------------------------------------------------

describe("createExternalSymbol", () => {
  it("creates an external symbol row for an npm function", () => {
    const scipSymbol = "scip-typescript npm lodash 4.17.21 lodash/map().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12, // Function
      displayName: "map",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "map");
    assert.strictEqual(result.kind, "function");
    assert.strictEqual(result.external, true);
    assert.strictEqual(result.source, "scip");
    assert.strictEqual(result.exported, true);
    assert.strictEqual(result.repoId, "my-repo");
    assert.strictEqual(result.packageName, "lodash");
    assert.strictEqual(result.packageVersion, "4.17.21");
    assert.strictEqual(result.scipSymbol, scipSymbol);

    // relPath should follow the ext:// convention
    assert.ok(result.relPath.startsWith("ext://"));
    assert.ok(result.relPath.includes("lodash"));
  });

  it("creates an external symbol row for a Go type", () => {
    const scipSymbol =
      "scip-go gomod github.com/pkg/errors v0.9.1 errors/Error#";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 11, // Interface
      displayName: "Error",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "Error");
    assert.strictEqual(result.kind, "interface");
    assert.strictEqual(result.packageName, "github.com/pkg/errors");
    assert.strictEqual(result.packageVersion, "v0.9.1");
    assert.ok(result.relPath.startsWith("ext://scip-go/gomod/"));
  });

  it("creates an external symbol row for a Java class", () => {
    const scipSymbol =
      "scip-java maven com.google.guava:guava 31.1 com/google/common/collect/ImmutableList#";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 5, // Class
      displayName: "ImmutableList",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "ImmutableList");
    assert.strictEqual(result.kind, "class");
    assert.strictEqual(result.packageName, "com.google.guava:guava");
    assert.strictEqual(result.packageVersion, "31.1");
  });

  it("creates an external symbol row for a Cargo crate function", () => {
    const scipSymbol =
      "scip-rust cargo serde 1.0.188 serde/Serialize#serialize().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 6, // Method
      displayName: "serialize",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "serialize");
    assert.strictEqual(result.kind, "method");
    assert.strictEqual(result.packageName, "serde");
    assert.strictEqual(result.packageVersion, "1.0.188");
  });

  it("generates stable symbolId for same input", () => {
    const scipSymbol = "scip-typescript npm lodash 4.17.21 lodash/map().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "map",
    });

    const result1 = createExternalSymbol(scipSymbol, info, "my-repo");
    const result2 = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result1 !== null);
    assert.ok(result2 !== null);
    assert.strictEqual(result1.symbolId, result2.symbolId);
  });

  it("generates different symbolId for different repos", () => {
    const scipSymbol = "scip-typescript npm lodash 4.17.21 lodash/map().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "map",
    });

    const result1 = createExternalSymbol(scipSymbol, info, "repo-a");
    const result2 = createExternalSymbol(scipSymbol, info, "repo-b");

    assert.ok(result1 !== null);
    assert.ok(result2 !== null);
    assert.notStrictEqual(result1.symbolId, result2.symbolId);
  });

  it("generates different symbolId for different symbols", () => {
    const info1 = makeExternalInfo({
      symbol: "scip-typescript npm lodash 4.17.21 lodash/map().",
      kind: 12,
      displayName: "map",
    });
    const info2 = makeExternalInfo({
      symbol: "scip-typescript npm lodash 4.17.21 lodash/filter().",
      kind: 12,
      displayName: "filter",
    });

    const result1 = createExternalSymbol(info1.symbol, info1, "my-repo");
    const result2 = createExternalSymbol(info2.symbol, info2, "my-repo");

    assert.ok(result1 !== null);
    assert.ok(result2 !== null);
    assert.notStrictEqual(result1.symbolId, result2.symbolId);
  });

  it("returns null for unmappable kinds (type parameter)", () => {
    const scipSymbol = "scip-typescript npm pkg 1.0.0 src/Foo#T[";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 26, // TypeParameter
      displayName: "T",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");
    assert.strictEqual(result, null);
  });

  it("returns null for local symbols (parameter)", () => {
    const scipSymbol = "scip-typescript npm pkg 1.0.0 src/foo()/x(";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 13, // Variable
      displayName: "x",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");
    assert.strictEqual(result, null);
  });

  it("uses displayName from SCIP info when available", () => {
    const scipSymbol = "scip-typescript npm pkg 1.0.0 src/utils/myHelper().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "myHelper",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "myHelper");
  });

  it("falls back to descriptor-extracted name when displayName is empty", () => {
    const scipSymbol = "scip-typescript npm pkg 1.0.0 src/utils/computeHash().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "", // empty
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.name, "computeHash");
  });

  it("builds correct synthetic relPath format", () => {
    const scipSymbol =
      "scip-typescript npm @types/node 18.0.0 path/posix/join().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "join",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    // ext://<scheme>/<manager>/<package>/<version>/<normalized descriptors>
    assert.strictEqual(
      result.relPath,
      "ext://scip-typescript/npm/@types/node/18.0.0/path/posix/join",
    );
  });

  it("normalizes # separators in relPath to /", () => {
    const scipSymbol =
      "scip-java maven com.example:lib 1.0 com/example/Foo#bar().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 6, // Method
      displayName: "bar",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    // # should be replaced with /
    assert.ok(!result.relPath.includes("#"));
    assert.ok(result.relPath.includes("Foo/bar"));
  });

  it("symbolId is a valid hex string of 64 chars (sha256)", () => {
    const scipSymbol = "scip-typescript npm lodash 4.17.21 lodash/map().";
    const info = makeExternalInfo({
      symbol: scipSymbol,
      kind: 12,
      displayName: "map",
    });

    const result = createExternalSymbol(scipSymbol, info, "my-repo");

    assert.ok(result !== null);
    assert.strictEqual(result.symbolId.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(result.symbolId));
  });
});
