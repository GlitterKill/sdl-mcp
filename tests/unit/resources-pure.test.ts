import { describe, it } from "node:test";
import assert from "node:assert";
import { readSliceResource } from "../../src/mcp/resources.js";

describe("readSliceResource", () => {
  it("returns JSON for valid slice:// URI", () => {
    const result = readSliceResource("slice://my-repo/v123");
    assert.ok(result !== null);
    const parsed = JSON.parse(result!);
    assert.strictEqual(parsed.sliceId, "v123");
    assert.ok(typeof parsed.message === "string");
  });

  it("returns null for invalid URI (no scheme)", () => {
    assert.strictEqual(readSliceResource("my-repo/v123"), null);
  });

  it("returns null for card:// URI", () => {
    assert.strictEqual(readSliceResource("card://repo/sym@v1"), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(readSliceResource(""), null);
  });

  it("returns null for slice:// with only repo (no sliceId)", () => {
    // regex requires at least one char after the second slash
    assert.strictEqual(readSliceResource("slice://my-repo/"), null);
  });

  it("handles repo with dots and hyphens", () => {
    const result = readSliceResource("slice://my-repo.v2/build-abc-123");
    assert.ok(result !== null);
    const parsed = JSON.parse(result!);
    assert.strictEqual(parsed.sliceId, "build-abc-123");
  });

  it("handles sliceId with dots and numbers", () => {
    const result = readSliceResource("slice://repo/v1.2.3-beta");
    assert.ok(result !== null);
    const parsed = JSON.parse(result!);
    assert.strictEqual(parsed.sliceId, "v1.2.3-beta");
  });

  it("handles sliceId with path separators", () => {
    const result = readSliceResource("slice://repo/some/nested/id");
    assert.ok(result !== null);
    const parsed = JSON.parse(result!);
    assert.strictEqual(parsed.sliceId, "some/nested/id");
  });
});
