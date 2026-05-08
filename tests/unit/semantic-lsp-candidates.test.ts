import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  planLspCallDefinitionCandidatesFromRows,
  type LspCandidateSkip,
} from "../../dist/semantic/providers/lsp/candidates.js";
import type { SemanticLspCallEdgeCandidateRow } from "../../dist/db/ladybug-semantic.js";

function writeRepoFile(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function makeRow(
  overrides: Partial<SemanticLspCallEdgeCandidateRow> = {},
): SemanticLspCallEdgeCandidateRow {
  return {
    sourceSymbolId: "sym:caller",
    sourceName: "caller",
    sourceKind: "function",
    sourcePath: "src/caller.ts",
    sourceFileId: "file:caller",
    sourceLanguage: "typescript",
    sourceRangeStartLine: 1,
    sourceRangeStartCol: 7,
    sourceRangeEndLine: 3,
    sourceRangeEndCol: 1,
    targetSymbolId: "unresolved:call:missingCall",
    targetName: "missingCall",
    edgeResolution: "unresolved",
    edgeConfidence: 0.5,
    edgeResolverId: "pass1-generic",
    edgeProvenance: "unresolved-call:missingCall",
    fileContentHash: "hash",
    ...overrides,
  };
}

describe("LSP call-definition candidate planning", () => {
  it("plans unresolved call candidates with zero-based LSP positions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-candidate-"));
    try {
      writeRepoFile(
        repoRoot,
        "src/caller.ts",
        [
          "export function caller() {",
          "  return missingCall();",
          "}",
          "",
        ].join("\n"),
      );

      const plan = await planLspCallDefinitionCandidatesFromRows({
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        candidateLimit: 10,
        rows: [makeRow()],
      });

      assert.equal(plan.candidates.length, 1);
      assert.equal(plan.skipped.length, 0);
      assert.equal(plan.candidates[0].sourceSymbolId, "sym:caller");
      assert.equal(plan.candidates[0].targetName, "missingCall");
      assert.deepEqual(plan.candidates[0].position, {
        line: 1,
        character: 9,
      });
      assert.equal(plan.documents[0].languageId, "typescript");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips resolved edges and rows that cannot be matched safely", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-candidate-skip-"));
    try {
      writeRepoFile(
        repoRoot,
        "src/caller.ts",
        [
          "export function caller() {",
          "  return missingCall();",
          "}",
          "",
        ].join("\n"),
      );

      const plan = await planLspCallDefinitionCandidatesFromRows({
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        candidateLimit: 10,
        rows: [
          makeRow({ edgeResolution: "exact" }),
          makeRow({ targetSymbolId: "sym:target", targetName: null }),
          makeRow({ sourceRangeStartLine: 10 }),
        ],
      });

      const reasons = plan.skipped.map((skip: LspCandidateSkip) => skip.reason);
      assert.deepEqual(reasons, [
        "resolved-edge",
        "target-name-missing",
        "source-symbol-not-found",
      ]);
      assert.equal(plan.candidates.length, 0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports unsupported languages and applies the candidate limit deterministically", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-candidate-limit-"));
    try {
      writeRepoFile(
        repoRoot,
        "src/caller.ts",
        [
          "export function caller() {",
          "  missingCall();",
          "}",
          "",
        ].join("\n"),
      );

      const unsupported = await planLspCallDefinitionCandidatesFromRows({
        repoId: "repo",
        repoRoot,
        languageId: "python",
        candidateLimit: 10,
        rows: [makeRow({ sourceLanguage: "python" })],
      });
      assert.deepEqual(unsupported.skipped.map((skip) => skip.reason), [
        "unsupported-language",
      ]);

      const limited = await planLspCallDefinitionCandidatesFromRows({
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        candidateLimit: 1,
        rows: [makeRow(), makeRow({ edgeConfidence: 0.4 })],
      });

      assert.equal(limited.candidates.length, 1);
      assert.ok(
        limited.skipped.some((skip) => skip.reason === "candidate-limit"),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
