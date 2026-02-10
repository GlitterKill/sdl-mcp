import { describe, it } from "node:test";
import assert from "node:assert";
import { isOpaqueSymbolIdRef, pickDepLabel } from "../../src/util/depLabels.js";

describe("dep label helpers", () => {
  it("detects opaque 64-char hash symbol references", () => {
    assert.strictEqual(
      isOpaqueSymbolIdRef(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
      true,
    );
    assert.strictEqual(isOpaqueSymbolIdRef("buildSlice"), false);
    assert.strictEqual(isOpaqueSymbolIdRef("unresolved:dynamic:foo"), false);
  });

  it("prefers readable names and drops opaque hash fallbacks", () => {
    assert.strictEqual(
      pickDepLabel(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "buildSlice",
      ),
      "buildSlice",
    );
    assert.strictEqual(
      pickDepLabel(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
      undefined,
    );
    assert.strictEqual(pickDepLabel("unresolved:dynamic:foo"), "unresolved:dynamic:foo");
  });
});
