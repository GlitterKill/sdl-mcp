import { describe, it } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseTypeScript(code: string): any {
  const TypeScript = require("tree-sitter-typescript");
  const Parser = require("tree-sitter");
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code);
}

describe("extractImports", () => {
  it("extracts named relative ESM imports", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript('import { foo } from "./bar";');

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 1);
    assert.deepStrictEqual(imports[0], {
      specifier: "./bar",
      isRelative: true,
      isExternal: false,
      imports: ["foo"],
      isReExport: false,
    });
  });

  it("extracts default external imports", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript('import React from "react";');

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 1);
    assert.strictEqual(imports[0].specifier, "react");
    assert.strictEqual(imports[0].defaultImport, "React");
    assert.strictEqual(imports[0].isRelative, false);
    assert.strictEqual(imports[0].isExternal, true);
    assert.deepStrictEqual(imports[0].imports, []);
    assert.strictEqual(imports[0].isReExport, false);
  });

  it("extracts namespace imports", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript('import * as fs from "node:fs";');

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 1);
    assert.strictEqual(imports[0].specifier, "node:fs");
    assert.strictEqual(imports[0].namespaceImport, "fs");
    assert.strictEqual(imports[0].isRelative, false);
    assert.strictEqual(imports[0].isReExport, false);
  });

  it("extracts re-exports and marks isReExport", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript('export { foo } from "./bar";');

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 1);
    assert.strictEqual(imports[0].specifier, "./bar");
    assert.deepStrictEqual(imports[0].imports, ["foo"]);
    assert.strictEqual(imports[0].isReExport, true);
    assert.strictEqual(imports[0].isRelative, true);
    assert.strictEqual(imports[0].isExternal, false);
  });

  it("returns empty array when there are no import/export statements", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript("const x = 1; function y() { return x; }");

    const imports = extractImports(tree);

    assert.deepStrictEqual(imports, []);
  });

  it("extracts multiple imports and re-exports from one file", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript(
      `
import React from "react";
import { useState as useLocalState } from "./state";
export { helper as exportedHelper } from "../utils/helper";
`.trim(),
    );

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 3);
    assert.strictEqual(imports[0].defaultImport, "React");
    assert.strictEqual(imports[1].imports[0], "useLocalState");
    assert.strictEqual(imports[1].isRelative, true);
    assert.strictEqual(imports[2].isReExport, true);
    assert.deepStrictEqual(imports[2].imports, ["exportedHelper"]);
  });

  it("does not extract dynamic import() calls", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript(
      `
async function loadMod() {
  return import("./dynamic");
}
`.trim(),
    );

    const imports = extractImports(tree);

    assert.deepStrictEqual(imports, []);
  });

  it("marks Node builtin specifiers as non-external", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript('import fs from "fs";');

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 1);
    assert.strictEqual(imports[0].specifier, "fs");
    assert.strictEqual(imports[0].isExternal, false);
    assert.strictEqual(imports[0].defaultImport, "fs");
  });

  it("marks node: and builtin subpath specifiers as non-external", () => {
    const {
      extractImports,
    } = require("../../dist/indexer/treesitter/extractImports.js");
    const tree = parseTypeScript(`
import fs from "node:fs";
import { test } from "node:test";
import promises from "fs/promises";
`.trim());

    const imports = extractImports(tree);

    assert.strictEqual(imports.length, 3);
    assert.ok(imports.every((entry: { isExternal: boolean }) => entry.isExternal === false));
    assert.deepStrictEqual(
      imports.map((entry: { specifier: string }) => entry.specifier),
      ["node:fs", "node:test", "fs/promises"],
    );
  });
});
