import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { getDb } from "../../src/db/db.js";
import {
  createEdgeTransaction,
  createRepo,
  getEdgesFrom,
  getFileByRepoPath,
  upsertFile,
  upsertSymbolTransaction,
} from "../../src/db/queries.js";
import { hashContent } from "../../src/util/hashing.js";
import {
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
} from "../../src/graph/slice.js";
import { SliceBuildRequestSchema } from "../../src/mcp/tools.js";

describe("edge confidence", () => {
  const repoId = "test-edge-confidence";
  const fromSymbol = "test-edge-confidence:from";
  const toSymbol = "test-edge-confidence:to";

  before(() => {
    const db = getDb();
    db.exec(`DELETE FROM edges WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM symbols WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM files WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM repos WHERE repo_id='${repoId}'`);

    createRepo({
      repo_id: repoId,
      root_path: ".",
      config_json: JSON.stringify({
        repoId,
        rootPath: ".",
        languages: ["ts", "tsx", "js", "jsx"],
        ignore: ["**/node_modules/**"],
      }),
      created_at: new Date().toISOString(),
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/a.ts",
      content_hash: hashContent("a"),
      language: "ts",
      byte_size: 1,
      last_indexed_at: new Date().toISOString(),
    });
    const file = getFileByRepoPath(repoId, "src/a.ts");
    assert.ok(file, "file should exist");

    upsertSymbolTransaction({
      symbol_id: fromSymbol,
      repo_id: repoId,
      file_id: file!.file_id,
      kind: "function",
      name: "from",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 1,
      range_end_col: 10,
      ast_fingerprint: "fp-from",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: new Date().toISOString(),
    });
    upsertSymbolTransaction({
      symbol_id: toSymbol,
      repo_id: repoId,
      file_id: file!.file_id,
      kind: "function",
      name: "to",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 2,
      range_start_col: 0,
      range_end_line: 2,
      range_end_col: 10,
      ast_fingerprint: "fp-to",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: new Date().toISOString(),
    });
  });

  after(() => {
    const db = getDb();
    db.exec(`DELETE FROM edges WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM symbols WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM files WHERE repo_id='${repoId}'`);
    db.exec(`DELETE FROM repos WHERE repo_id='${repoId}'`);
  });

  it("persists explicit edge confidence", () => {
    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: fromSymbol,
      to_symbol_id: toSymbol,
      type: "call",
      weight: 1,
      confidence: 0.42,
      provenance: "test",
      created_at: new Date().toISOString(),
    });

    const edges = getEdgesFrom(fromSymbol).filter((edge) => edge.to_symbol_id === toSymbol);
    assert.ok(edges.length > 0, "expected at least one edge");
    assert.strictEqual(edges[edges.length - 1].confidence, 0.42);
  });

  it("multiplies edge type weight by confidence", () => {
    assert.strictEqual(applyEdgeConfidenceWeight(1, 0.25), 0.25);
    assert.strictEqual(applyEdgeConfidenceWeight(0.6, undefined), 0.6);
  });

  it("raises effective min confidence at 70% and 90% token usage", () => {
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 200, 1000), 0.5);
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 750, 1000), 0.8);
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 950, 1000), 0.95);
    assert.strictEqual(getAdaptiveMinConfidence(0.92, 950, 1000), 0.95);
  });

  it("accepts minConfidence in slice.build input and defaults to 0.5", () => {
    const parsed = SliceBuildRequestSchema.parse({
      repoId: "repo-1",
      taskText: "find impact of call edge confidence",
    });
    assert.strictEqual(parsed.minConfidence, 0.5);
  });
});
