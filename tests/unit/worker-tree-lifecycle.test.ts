import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("parser worker tree lifecycle", () => {
  it("releases worker-owned tree-sitter trees after extraction", () => {
    const workerSource = readFileSync(
      join(process.cwd(), "src/indexer/worker.ts"),
      "utf8",
    );

    assert.match(
      workerSource,
      /let\s+treeToDelete:[\s\S]*?finally\s*\{[\s\S]*?treeToDelete\?\.delete\?\.\(\);[\s\S]*?\}/,
      "worker.ts must delete the tree-sitter Tree it creates so long legacy Pass 1 runs do not leak native parser memory",
    );
  });
});
