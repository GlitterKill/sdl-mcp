import assert from "node:assert";
import { describe, it } from "node:test";
import { rankSymbols } from "../../../dist/agent/context-ranking.js";
import type { AgentTask } from "../../../dist/agent/types.js";

describe("Language Affinity Scoring", () => {
  function makeSymbol(
    id: string,
    name: string,
    fileId: string,
    kind = "function",
  ) {
    return {
      name,
      kind,
      exported: true,
      fileId,
    };
  }

  function makeTask(taskText: string): AgentTask {
    return {
      taskType: "debug",
      taskText,
      repoId: "test-repo",
    };
  }

  it("boosts TypeScript symbols when task mentions TypeScript terms", () => {
    const symbolMap = new Map([
      ["ts-sym", makeSymbol("ts-sym", "handleRequest", "test-repo:src/server.ts")],
      ["py-sym", makeSymbol("py-sym", "handle_request", "test-repo:src/server.py")],
      ["rs-sym", makeSymbol("rs-sym", "handle_request", "test-repo:src/server.rs")],
    ]);

    const result = rankSymbols(
      ["ts-sym", "py-sym", "rs-sym"],
      symbolMap,
      ["handleRequest"],
      makeTask("The TypeScript interface for handling requests is broken"),
    );

    const tsScore = result.ranked.find((s) => s.symbolId === "ts-sym");
    const pyScore = result.ranked.find((s) => s.symbolId === "py-sym");

    assert.ok(tsScore, "Should find ts symbol in results");
    assert.ok(pyScore, "Should find py symbol in results");
    assert.ok(
      tsScore!.languageAffinity > 0,
      `TS symbol should have languageAffinity > 0, got ${tsScore!.languageAffinity}`,
    );
    assert.strictEqual(
      pyScore!.languageAffinity,
      0,
      "Python symbol should have languageAffinity = 0 for TS query",
    );
  });

  it("boosts Rust symbols when task mentions Rust terms", () => {
    const symbolMap = new Map([
      ["ts-sym", makeSymbol("ts-sym", "process", "test-repo:src/main.ts")],
      ["rs-sym", makeSymbol("rs-sym", "process", "test-repo:src/main.rs")],
    ]);

    const result = rankSymbols(
      ["ts-sym", "rs-sym"],
      symbolMap,
      ["process"],
      makeTask("The Rust crate is not compiling the process function"),
    );

    const rsScore = result.ranked.find((s) => s.symbolId === "rs-sym");
    const tsScore = result.ranked.find((s) => s.symbolId === "ts-sym");

    assert.ok(
      rsScore!.languageAffinity > tsScore!.languageAffinity,
      `Rust affinity (${rsScore!.languageAffinity}) should exceed TS affinity (${tsScore!.languageAffinity})`,
    );
  });

  it("boosts Python symbols when task mentions Python terms", () => {
    const symbolMap = new Map([
      ["py-sym", makeSymbol("py-sym", "parse_config", "test-repo:src/config.py")],
      ["ts-sym", makeSymbol("ts-sym", "parseConfig", "test-repo:src/config.ts")],
    ]);

    const result = rankSymbols(
      ["py-sym", "ts-sym"],
      symbolMap,
      ["parseConfig"],
      makeTask("The python def parse_config is returning None"),
    );

    const pyScore = result.ranked.find((s) => s.symbolId === "py-sym");
    assert.ok(
      pyScore!.languageAffinity > 0,
      `Python symbol should have affinity > 0, got ${pyScore!.languageAffinity}`,
    );
  });

  it("applies no affinity when task has no language signal", () => {
    const symbolMap = new Map([
      ["sym1", makeSymbol("sym1", "process", "test-repo:src/main.ts")],
      ["sym2", makeSymbol("sym2", "process", "test-repo:src/main.py")],
    ]);

    const result = rankSymbols(
      ["sym1", "sym2"],
      symbolMap,
      ["process"],
      makeTask("The process function is broken"),
    );

    for (const scored of result.ranked) {
      assert.strictEqual(
        scored.languageAffinity,
        0,
        `No affinity expected for generic query, got ${scored.languageAffinity} for ${scored.symbolId}`,
      );
    }
  });

  it("handles symbols without fileId gracefully", () => {
    const symbolMap = new Map([
      ["no-file", { name: "test", kind: "function", exported: true }],
    ]);

    const result = rankSymbols(
      ["no-file"],
      symbolMap,
      ["test"],
      makeTask("TypeScript test function"),
    );

    assert.strictEqual(result.ranked[0]!.languageAffinity, 0);
  });
});
