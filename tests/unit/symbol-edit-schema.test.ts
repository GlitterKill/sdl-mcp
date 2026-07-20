import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FileGatewayRequestSchema } from "../../dist/mcp/tools/file-gateway.js";
import { SymbolEditRequestSchema } from "../../dist/mcp/tools.js";

describe("SymbolEditRequestSchema", () => {
  it("parses preview with a symbolRef and operation object", () => {
    const parsed = SymbolEditRequestSchema.parse({
      mode: "preview",
      repoId: "repo-1",
      symbolRef: { name: "handleAuth", file: "src/server.ts" },
      operation: { kind: "replaceBody", content: "return true;\n" },
    });

    assert.equal(parsed.mode, "preview");
    assert.deepEqual(parsed.symbolRef, {
      name: "handleAuth",
      file: "src/server.ts",
    });
    assert.equal(parsed.operation.kind, "replaceBody");
  });

  it("requires an exact symbol snapshot for applyNow", () => {
    assert.throws(() => {
      SymbolEditRequestSchema.parse({
        mode: "applyNow",
        repoId: "repo-1",
        symbolId: "sym-1",
        operation: { kind: "replaceSymbol", content: "export function x() {}\n" },
      });
    }, /expectedAstFingerprint|expectedRange/);

    const parsed = SymbolEditRequestSchema.parse({
      mode: "applyNow",
      repoId: "repo-1",
      symbolId: "sym-1",
      expectedAstFingerprint: "fp-1",
      expectedRange: { startLine: 1, startCol: 0, endLine: 3, endCol: 1 },
      operation: { kind: "replaceSymbol", content: "export function x() {}\n" },
    });

    assert.equal(parsed.mode, "applyNow");
    assert.equal(parsed.expectedAstFingerprint, "fp-1");
  });

  it("parses sdl.file symbol edit wrapper operations", () => {
    const preview = FileGatewayRequestSchema.parse({
      op: "symbolEditPreview",
      repoId: "repo-1",
      symbolId: "sym-1",
      operation: { kind: "insertAfter", content: "\nexport const extra = 1;\n" },
    });
    assert.equal(preview.op, "symbolEditPreview");

    const apply = FileGatewayRequestSchema.parse({
      op: "symbolEditApply",
      repoId: "repo-1",
      planHandle: "se-abc",
    });
    assert.equal(apply.op, "symbolEditApply");

    const applyNow = FileGatewayRequestSchema.parse({
      op: "symbolEditApplyNow",
      repoId: "repo-1",
      symbolId: "sym-1",
      expectedAstFingerprint: "fp-1",
      expectedRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
      operation: { kind: "renameLocal", name: "value", replacement: "nextValue" },
    });
    assert.equal(applyNow.op, "symbolEditApplyNow");
  });

  it("accepts temporary rollback backup options without changing request defaults", () => {
    const direct = SymbolEditRequestSchema.parse({
      mode: "preview",
      repoId: "repo-1",
      symbolId: "sym-1",
      operation: { kind: "replaceBody", content: "return true;\n" },
      createBackup: true,
    });
    const wrapped = FileGatewayRequestSchema.parse({
      op: "symbolEditApply",
      repoId: "repo-1",
      planHandle: "se-abc",
      createBackup: true,
    });

    assert.equal(direct.createBackup, true);
    assert.equal(wrapped.createBackup, true);
  });
});
