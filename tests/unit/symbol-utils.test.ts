import { describe, it } from "node:test";
import assert from "node:assert";
import { toLegacySymbolRow } from "../../src/mcp/tools/symbol-utils.js";

function makeSymbolRow(overrides: Record<string, unknown> = {}) {
  return {
    symbolId: "sym-1",
    repoId: "repo-1",
    fileId: "file-abc",
    kind: "function",
    name: "doStuff",
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 10,
    rangeStartCol: 2,
    rangeEndLine: 25,
    rangeEndCol: 1,
    astFingerprint: "fp-hash",
    signatureJson: '{"name":"doStuff"}',
    summary: "Does stuff",
    invariantsJson: '["non-null"]',
    sideEffectsJson: '["logs"]',
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as any;
}

describe("toLegacySymbolRow", () => {
  it("maps all fields correctly for exported=true", () => {
    const legacy = toLegacySymbolRow(makeSymbolRow());
    assert.strictEqual(legacy.symbol_id, "sym-1");
    assert.strictEqual(legacy.repo_id, "repo-1");
    assert.strictEqual(legacy.file_id, 0);
    assert.strictEqual(legacy.kind, "function");
    assert.strictEqual(legacy.name, "doStuff");
    assert.strictEqual(legacy.exported, 1);
    assert.strictEqual(legacy.visibility, "public");
    assert.strictEqual(legacy.language, "typescript");
    assert.strictEqual(legacy.range_start_line, 10);
    assert.strictEqual(legacy.range_start_col, 2);
    assert.strictEqual(legacy.range_end_line, 25);
    assert.strictEqual(legacy.range_end_col, 1);
    assert.strictEqual(legacy.ast_fingerprint, "fp-hash");
    assert.strictEqual(legacy.signature_json, '{"name":"doStuff"}');
    assert.strictEqual(legacy.summary, "Does stuff");
    assert.strictEqual(legacy.invariants_json, '["non-null"]');
    assert.strictEqual(legacy.side_effects_json, '["logs"]');
    assert.strictEqual(legacy.updated_at, "2026-01-01T00:00:00Z");
  });

  it("maps exported=false to 0", () => {
    const legacy = toLegacySymbolRow(makeSymbolRow({ exported: false }));
    assert.strictEqual(legacy.exported, 0);
  });

  it("preserves null optional fields", () => {
    const legacy = toLegacySymbolRow(
      makeSymbolRow({
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
      }),
    );
    assert.strictEqual(legacy.summary, null);
    assert.strictEqual(legacy.invariants_json, null);
    assert.strictEqual(legacy.side_effects_json, null);
  });

  it("file_id is always 0 regardless of input", () => {
    const legacy = toLegacySymbolRow(makeSymbolRow({ fileId: "any-file-id" }));
    assert.strictEqual(legacy.file_id, 0);
  });
});
