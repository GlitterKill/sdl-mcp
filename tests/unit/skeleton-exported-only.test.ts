import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseFile,
  extractSkeletonFromNode,
} from "../../dist/code/skeleton.js";

describe("skeleton exportedOnly filtering", () => {
  const mixedExportFile = `
import { helper } from "./helper";

export function publicFunction(x: number): number {
  return x * 2;
}

function privateFunction(y: number): number {
  return y + 1;
}

export class PublicClass {
  method(): void {}
}

class PrivateClass {
  method(): void {}
}

export const PUBLIC_CONST = 42;

const PRIVATE_CONST = 99;
  `.trim();

  it("exportedOnly=false includes non-exported declarations", () => {
    const tree = parseFile(mixedExportFile, ".ts");
    assert.ok(tree, "Should parse the file");

    const skeleton = extractSkeletonFromNode(
      tree.rootNode,
      mixedExportFile,
      [],
      0,
      false,
    );

    assert.ok(
      skeleton.includes("privateFunction"),
      "Should include privateFunction when exportedOnly=false",
    );
    assert.ok(
      skeleton.includes("publicFunction"),
      "Should include publicFunction when exportedOnly=false",
    );
    assert.ok(
      skeleton.includes("PrivateClass"),
      "Should include PrivateClass when exportedOnly=false",
    );
  });

  it("exportedOnly=true excludes non-exported declarations", () => {
    const tree = parseFile(mixedExportFile, ".ts");
    assert.ok(tree, "Should parse the file");

    const skeletonExported = extractSkeletonFromNode(
      tree.rootNode,
      mixedExportFile,
      [],
      0,
      true,
    );

    assert.ok(
      skeletonExported.includes("publicFunction"),
      "Should include publicFunction when exportedOnly=true",
    );
    assert.ok(
      skeletonExported.includes("PublicClass"),
      "Should include PublicClass when exportedOnly=true",
    );
    assert.ok(
      !skeletonExported.includes("privateFunction"),
      "Should exclude privateFunction when exportedOnly=true",
    );
    assert.ok(
      !skeletonExported.includes("PrivateClass"),
      "Should exclude PrivateClass when exportedOnly=true",
    );
  });

  it("exportedOnly=true produces fewer lines than exportedOnly=false", () => {
    const tree = parseFile(mixedExportFile, ".ts");
    assert.ok(tree, "Should parse the file");

    const skeletonFull = extractSkeletonFromNode(
      tree.rootNode,
      mixedExportFile,
      [],
      0,
      false,
    );
    const skeletonExported = extractSkeletonFromNode(
      tree.rootNode,
      mixedExportFile,
      [],
      0,
      true,
    );

    const fullLines = skeletonFull.split("\n").filter((l) => l.trim().length > 0).length;
    const exportedLines = skeletonExported.split("\n").filter((l) => l.trim().length > 0).length;

    assert.ok(
      exportedLines < fullLines,
      `Exported-only skeleton (${exportedLines} lines) should have fewer lines than full skeleton (${fullLines} lines)`,
    );
  });

  it("importStatements are always included regardless of exportedOnly", () => {
    const tree = parseFile(mixedExportFile, ".ts");
    assert.ok(tree, "Should parse the file");

    const skeletonExported = extractSkeletonFromNode(
      tree.rootNode,
      mixedExportFile,
      [],
      0,
      true,
    );

    assert.ok(
      skeletonExported.includes("import"),
      "Should include import statements even when exportedOnly=true",
    );
  });
});
