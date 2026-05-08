import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  normalizeLsifElements,
  parseLsifElements,
} from "../../dist/semantic/providers/lsif/reader.js";

describe("LSIF semantic provider normalization", () => {
  it("normalizes documents, ranges, and definition edges", () => {
    const repoRoot = process.cwd();
    const fileUri = pathToFileURL(
      join(repoRoot, "src", "example.ts"),
    ).toString();
    const index = normalizeLsifElements(
      [
        { id: "doc", type: "vertex", label: "document", uri: fileUri },
        {
          id: "sourceRange",
          type: "vertex",
          label: "range",
          start: { line: 1, character: 2 },
          end: { line: 1, character: 8 },
        },
        {
          id: "targetRange",
          type: "vertex",
          label: "range",
          start: { line: 4, character: 0 },
          end: { line: 4, character: 6 },
        },
        {
          id: "contains",
          type: "edge",
          label: "contains",
          outV: "doc",
          inVs: ["sourceRange", "targetRange"],
        },
        {
          id: "nextSource",
          type: "edge",
          label: "next",
          outV: "sourceRange",
          inV: "sourceResultSet",
        },
        {
          id: "definitionLink",
          type: "edge",
          label: "textDocument/definition",
          outV: "sourceResultSet",
          inV: "definitionResult",
        },
        {
          id: "definitionItem",
          type: "edge",
          label: "item",
          outV: "definitionResult",
          inVs: ["targetRange"],
        },
      ],
      {
        repoId: "repo",
        repoRoot,
        indexPath: join(repoRoot, "index.lsif"),
        runId: "run",
      },
    );

    assert.equal(index.providerType, "lsif");
    assert.equal(index.documents[0].sourcePath, "src/example.ts");
    assert.equal(index.symbols.length, 2);
    assert.equal(index.edges.length, 1);
    assert.equal(index.edges[0].resolverId, "lsif:lsif");
    assert.equal(
      index.edges[0].sourceProviderSymbolId,
      "lsif:src/example.ts#sourceRange",
    );
    assert.equal(
      index.edges[0].targetProviderSymbolId,
      "lsif:src/example.ts#targetRange",
    );
  });

  it("filters combined indexes by selected language", () => {
    const repoRoot = process.cwd();
    const tsUri = pathToFileURL(join(repoRoot, "src", "example.ts")).toString();
    const pyUri = pathToFileURL(join(repoRoot, "src", "example.py")).toString();

    const index = normalizeLsifElements(
      [
        { id: "tsDoc", type: "vertex", label: "document", uri: tsUri },
        { id: "pyDoc", type: "vertex", label: "document", uri: pyUri },
      ],
      {
        repoId: "repo",
        repoRoot,
        indexPath: join(repoRoot, "index.lsif"),
        runId: "run",
        languages: ["typescript"],
      },
    );

    assert.deepEqual(
      index.documents.map((document) => document.sourcePath),
      ["src/example.ts"],
    );
  });

  it("rejects LSIF payloads beyond the configured element cap", () => {
    assert.throws(
      () =>
        parseLsifElements(
          [
            JSON.stringify({ id: "a", type: "vertex", label: "document" }),
            JSON.stringify({ id: "b", type: "vertex", label: "document" }),
          ].join("\n"),
          { maxElements: 1 },
        ),
      /maximum element count/,
    );
  });
});
