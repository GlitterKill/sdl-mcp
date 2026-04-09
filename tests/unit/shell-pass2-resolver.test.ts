import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ShellPass2Resolver } from "../../dist/indexer/pass2/resolvers/shell-pass2-resolver.js";
// Phase 2 Task 2.10.1 -- import helper directly from source via .ts (strip-types).
import { collectCommandEvalCallSites } from "../../src/indexer/pass2/resolvers/shell-pass2-helpers.ts";

type MockNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild: (index: number) => MockNode | null;
};

function mkNode(
  type: string,
  text: string,
  children: MockNode[] = [],
  startRow = 0,
): MockNode {
  return {
    type,
    text,
    startPosition: { row: startRow, column: 0 },
    endPosition: { row: startRow, column: text.length },
    namedChildCount: children.length,
    namedChild: (i: number) => children[i] ?? null,
  };
}

describe("ShellPass2Resolver", () => {
  it("supports shell files only", () => {
    const resolver = new ShellPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "scripts/deploy.sh",
        extension: ".sh",
        language: "shell",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "scripts/env.bash",
        extension: ".bash",
        language: "shell",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.py",
        extension: ".py",
        language: "python",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.c",
        extension: ".c",
        language: "c",
      }),
      false,
    );
  });

  it("exposes pass2-shell resolver id", () => {
    const resolver = new ShellPass2Resolver();
    assert.equal(resolver.id, "pass2-shell");
  });

  it("requires repoId on the target", async () => {
    const resolver = new ShellPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "scripts/deploy.sh",
          extension: ".sh",
          language: "shell",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["sh", "bash"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });

  it("resolves command/eval call to shell function", () => {
    // Build a mock tree that mirrors what tree-sitter produces for:
    //   command greet
    //   eval "greet"
    // The walker only touches a minimal subset of the SyntaxNode API.
    const commandInvocation = mkNode(
      "command",
      "command greet",
      [
        mkNode("command_name", "command"),
        mkNode("word", "greet"),
      ],
      5,
    );
    const evalInvocation = mkNode(
      "command",
      'eval "greet"',
      [
        mkNode("command_name", "eval"),
        mkNode("string", '"greet"'),
      ],
      6,
    );
    const program = mkNode("program", "", [commandInvocation, evalInvocation]);

    const calls = collectCommandEvalCallSites(program as unknown as never);
    const greetCalls = calls.filter((c) => c.calleeIdentifier === "greet");
    assert.equal(
      greetCalls.length,
      2,
      `expected 2 indirect greet calls, got ${calls.length}: ${JSON.stringify(calls)}`,
    );
    for (const c of greetCalls) {
      assert.equal(c.callType, "function");
      assert.equal(c.isResolved, false);
    }
  });
});
