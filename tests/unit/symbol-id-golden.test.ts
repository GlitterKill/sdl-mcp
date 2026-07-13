import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { generateSymbolId } from "../../dist/indexer/fingerprints.js";

interface SymbolIdGoldenVector {
  repoId: string;
  relPath: string;
  kind: string;
  name: string;
  astFingerprint: string;
  expectedSymbolId: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/symbol-id-golden.json", import.meta.url), "utf8"),
) as SymbolIdGoldenVector[];

describe("SymbolID golden vectors", () => {
  for (const vector of vectors) {
    it(`pins ${vector.repoId}:${vector.relPath}:${vector.name}`, () => {
      assert.equal(
        generateSymbolId(
          vector.repoId,
          vector.relPath,
          vector.kind,
          vector.name,
          vector.astFingerprint,
        ),
        vector.expectedSymbolId,
      );
    });
  }
});
