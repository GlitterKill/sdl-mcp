import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SCIP_MAX_INDEX_BYTES } from "../../dist/scip/limits.js";
import { TypeScriptScipDecoder } from "../../dist/scip/decoder-ts.js";

describe("SCIP decoder limits", () => {
  it("uses a 512 MiB cap in the TypeScript decoder export", () => {
    assert.equal(SCIP_MAX_INDEX_BYTES, 512 * 1024 * 1024);
    assert.equal(TypeScriptScipDecoder.MAX_INDEX_SIZE, SCIP_MAX_INDEX_BYTES);
  });

  it("uses a 512 MiB cap in the native decoder source", () => {
    const source = readFileSync("native/src/scip/decoder.rs", "utf-8");
    assert.match(source, /MAX_SCIP_INDEX_BYTES:\s*u64\s*=\s*512\s*\*\s*1024\s*\*\s*1024/);
  });
});

