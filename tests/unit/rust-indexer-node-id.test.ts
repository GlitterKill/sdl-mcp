import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRustEngineAvailable,
  parseFilesRust,
} from "../../dist/indexer/rustIndexer.js";

/**
 * Task 1.2 acceptance test: Rust-side `callerNodeId` / symbol `nodeId`
 * disambiguation for same-name symbols.
 *
 * The Rust extractor emits node IDs of the form `name:startLine:startCol`
 * (see `native/src/extract/calls/common.rs::make_node_id`). When two
 * distinct symbols share a name (e.g. overloaded method names across
 * classes), their node IDs MUST still be unique because the line/col
 * suffix disambiguates them. Call sites must also point at the correct
 * enclosing symbol via `find_enclosing_symbol`, which now returns
 * `sym.node_id` rather than `sym.name`.
 *
 * Skips cleanly when the native addon is unavailable, mirroring the
 * established rust-indexer*.test.ts pattern.
 */
describe("rustIndexer — deterministic nodeId / callerNodeId disambiguation", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-mcp-node-id-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("disambiguates same-name methods across two classes and attributes calls correctly", () => {
    if (!isRustEngineAvailable()) return;

    const relPath = "src/processors.ts";
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, relPath),
      [
        "export class AProcessor {",
        "  process(): string {",
        "    return this.helper();",
        "  }",
        "  helper(): string { return \"A\"; }",
        "}",
        "",
        "export class BProcessor {",
        "  process(): string {",
        "    return this.helper();",
        "  }",
        "  helper(): string { return \"B\"; }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = parseFilesRust("test-repo", tmpDir, [
      { path: relPath, size: 0, mtime: Date.now() },
    ]);
    assert.ok(result !== null, "parseFilesRust should return a non-null result");
    assert.strictEqual(result.length, 1);
    const parsed = result[0]!;
    assert.ok(!parsed.parseError, `parse failed: ${parsed.parseError ?? ""}`);

    // ── nodeId uniqueness ───────────────────────────────────────────────
    const nodeIds = parsed.symbols.map((s) => s.nodeId);
    const nodeIdSet = new Set(nodeIds);
    assert.strictEqual(
      nodeIdSet.size,
      nodeIds.length,
      `nodeIds must be unique across all symbols; got duplicates in ${JSON.stringify(nodeIds)}`,
    );

    // ── nodeId format ───────────────────────────────────────────────────
    // `make_node_id` format is `name:startLine:startCol`. Every nodeId
    // must end in two colon-separated integers, however many colons may
    // appear in the leading name component.
    const nodeIdShape = /:\d+:\d+$/;
    for (const nid of nodeIds) {
      assert.ok(
        nodeIdShape.test(nid),
        `nodeId "${nid}" must end with :startLine:startCol`,
      );
    }

    // ── Same-name disambiguation ────────────────────────────────────────
    const processMethods = parsed.symbols.filter((s) => s.name === "process");
    const helperMethods = parsed.symbols.filter((s) => s.name === "helper");
    assert.strictEqual(processMethods.length, 2, "expected two `process` methods");
    assert.strictEqual(helperMethods.length, 2, "expected two `helper` methods");
    assert.notStrictEqual(
      processMethods[0]!.nodeId,
      processMethods[1]!.nodeId,
      "same-name `process` methods must have distinct nodeIds",
    );
    assert.notStrictEqual(
      helperMethods[0]!.nodeId,
      helperMethods[1]!.nodeId,
      "same-name `helper` methods must have distinct nodeIds",
    );

    // ── callerNodeId is populated and references real symbols ──────────
    // Every call site’s callerNodeId must match the nodeId of some
    // symbol in the same file (because `find_enclosing_symbol` walks
    // upward through the emitted symbol table to find the owner).
    const helperCalls = parsed.calls.filter((c) => c.calleeIdentifier.endsWith("helper"));
    assert.strictEqual(
      helperCalls.length,
      2,
      `expected two "helper" calls (one per class), got ${helperCalls.length}`,
    );
    const callerIds = helperCalls.map((c) => c.callerNodeId);
    const callerIdSet = new Set(callerIds);
    assert.strictEqual(
      callerIdSet.size,
      2,
      `each same-name caller must have a distinct callerNodeId; got ${JSON.stringify(callerIds)}`,
    );
    for (const cid of callerIds) {
      assert.ok(
        nodeIdSet.has(cid),
        `callerNodeId "${cid}" must reference a symbol nodeId in the same file`,
      );
    }
  });
});
