import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveImportTargets } from "../../dist/indexer/edge-builder/import-resolution.js";

describe("resolveImportTargets target metadata", () => {
  it("marks outside-repo import placeholders as external", async () => {
    const result = await resolveImportTargets(
      "repo",
      "F:/tmp/repo",
      "src/example.ts",
      [
        {
          specifier: "node:test",
          isRelative: false,
          isExternal: false,
          imports: ["describe"],
          isReExport: false,
        },
        {
          specifier: "zod",
          isRelative: false,
          isExternal: true,
          imports: ["z"],
          isReExport: false,
        },
      ],
      [".ts"],
      "ts",
    );

    assert.deepEqual(result.targets, [
      {
        symbolId: "unresolved:node:test:describe",
        provenance: "node:test:describe",
        targetMeta: {
          symbolStatus: "external",
          placeholderKind: "import",
          placeholderTarget: "describe (from node:test)",
        },
      },
      {
        symbolId: "unresolved:zod:z",
        provenance: "zod:z",
        targetMeta: {
          symbolStatus: "external",
          placeholderKind: "import",
          placeholderTarget: "z (from zod)",
        },
      },
    ]);
  });

  it("keeps unresolved metadata for common TS path-alias misses", async () => {
    const result = await resolveImportTargets(
      "repo",
      "F:/tmp/repo",
      "src/example.ts",
      [
        {
          specifier: "@features/foo",
          isRelative: false,
          isExternal: true,
          imports: ["Foo"],
          isReExport: false,
        },
      ],
      [".ts"],
      "ts",
    );

    assert.deepEqual(result.targets, [
      {
        symbolId: "unresolved:@features/foo:Foo",
        provenance: "@features/foo:Foo",
        targetMeta: {
          symbolStatus: "unresolved",
          placeholderKind: "import",
          placeholderTarget: "Foo (from @features/foo)",
        },
      },
    ]);
  });

  it("marks package subpath misses as external", async () => {
    const result = await resolveImportTargets(
      "repo",
      process.cwd(),
      "src/example.ts",
      [
        {
          specifier: "@modelcontextprotocol/sdk/client/index.js",
          isRelative: false,
          isExternal: true,
          imports: ["Client"],
          isReExport: false,
        },
      ],
      [".ts"],
      "ts",
    );

    assert.deepEqual(result.targets, [
      {
        symbolId:
          "unresolved:@modelcontextprotocol/sdk/client/index.js:Client",
        provenance: "@modelcontextprotocol/sdk/client/index.js:Client",
        targetMeta: {
          symbolStatus: "external",
          placeholderKind: "import",
          placeholderTarget:
            "Client (from @modelcontextprotocol/sdk/client/index.js)",
        },
      },
    ]);
  });

  it("keeps unresolved metadata for syntactically repo-local import misses", async () => {
    const result = await resolveImportTargets(
      "repo",
      "F:/tmp/repo",
      "src/example.ts",
      [
        {
          specifier: "./missing.js",
          isRelative: true,
          isExternal: false,
          imports: ["Missing"],
          isReExport: false,
        },
      ],
      [".ts", ".js"],
      "ts",
    );

    assert.deepEqual(result.targets, [
      {
        symbolId: "unresolved:./missing.js:Missing",
        provenance: "./missing.js:Missing",
        targetMeta: {
          symbolStatus: "unresolved",
          placeholderKind: "import",
          placeholderTarget: "Missing (from ./missing.js)",
        },
      },
    ]);
  });
});
