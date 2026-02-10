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

  it("truncates long target names to DEP_LABEL_MAX_LENGTH (40)", () => {
    const longName = "thisIsAVeryLongFunctionNameThatExceedsFortyCharacters";
    const result = pickDepLabel("some-id", longName);
    assert.strictEqual(result?.length, 40);
    assert.strictEqual(result, longName.slice(0, 40));
  });

  it("truncates long targetId fallbacks to DEP_LABEL_MAX_LENGTH (40)", () => {
    const longId = "unresolved:dynamic:some/very/long/path/to/module/export";
    const result = pickDepLabel(longId);
    assert.strictEqual(result?.length, 40);
    assert.strictEqual(result, longId.slice(0, 40));
  });

  it("does not truncate names within limit", () => {
    const shortName = "buildSlice";
    assert.strictEqual(pickDepLabel("some-id", shortName), shortName);
  });

  it("does not truncate targetId fallbacks within limit", () => {
    const shortId = "unresolved:dynamic:foo";
    assert.strictEqual(pickDepLabel(shortId), shortId);
  });
});
