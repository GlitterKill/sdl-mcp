import assert from "node:assert";
import { describe, it } from "node:test";

import { zipSync, strToU8 } from "fflate";
import { validateSkinManifest } from "../../dist/ui/viewer/skins/manifest-schema.js";
import { loadSkinZip, validateSkinEntryPath } from "../../dist/ui/viewer/skins/loader.js";

const caps = { maxZipBytes: 50_000, maxEntries: 8, maxDecompressedBytes: 100_000 };

function skinZip(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "skin.json": strToU8(JSON.stringify({ schemaVersion: 1, name: "Unit", version: "1.0.0" })),
    ...extra,
  });
}

describe("viewer skin manifest", () => {
  it("accepts the minimal valid manifest", () => {
    const result = validateSkinManifest({ schemaVersion: 1, name: "Default", version: "1.0.0" });
    assert.equal(result.ok, true);
  });

  it("rejects missing required fields", () => {
    const result = validateSkinManifest({ schemaVersion: 1, name: "Broken" });
    assert.equal(result.ok, false);
  });
});

describe("viewer skin loader", () => {
  it("loads valid skin zips", () => {
    const loaded = loadSkinZip(skinZip({ "textures/star.png": new Uint8Array([1, 2, 3]) }), caps);
    assert.equal(loaded.manifest.name, "Unit");
    assert.equal(loaded.assets.has("textures/star.png"), true);
  });

  it("rejects traversal and absolute entry paths", () => {
    assert.equal(validateSkinEntryPath("../skin.json"), false);
    assert.equal(validateSkinEntryPath("/textures/star.png"), false);
    assert.equal(validateSkinEntryPath("C:/textures/star.png"), false);
    assert.throws(() => loadSkinZip(skinZip({ "../escape.txt": new Uint8Array([1]) }), caps));
  });

  it("enforces entry and decompressed byte caps", () => {
    assert.throws(() => loadSkinZip(skinZip(Object.fromEntries(Array.from({ length: 12 }, (_, index) => ["textures/" + index + ".png", new Uint8Array([1])]))), caps));
    assert.throws(() => loadSkinZip(skinZip({ "textures/huge.bin": new Uint8Array(100_001) }), caps));
  });
});
