import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { handleCodeNeedWindow } from "../../src/mcp/tools/code.js";
import { PolicyEngine } from "../../src/policy/engine.js";

describe("code.needWindow policy remediation", () => {
  // DB is set up once per suite to avoid Windows heap-corruption on multiple Kuzu close/reopen cycles.
  let tempDir = "";
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;
  let originalEvaluate: typeof PolicyEngine.prototype.evaluate;
  let originalGenerateNextBestAction: typeof PolicyEngine.prototype.generateNextBestAction;

  before(async () => {
    tempDir = join(tmpdir(), `sdl-mcp-code-window-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "example.ts"),
      [
        "export function demoWindow() {",
        "  const importantFlag = true;",
        "  return importantFlag;",
        "}",
        "",
      ].join("\n"),
    );

    const configPath = join(tempDir, "sdlmcp.config.json");
    const kuzuPath = join(tempDir, "graph.kuzu");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [
          {
            repoId: "repo-test",
            rootPath: tempDir,
            languages: ["ts"],
            ignore: [],
            maxFileBytes: 2_000_000,
          },
        ],
        graphDatabase: { path: kuzuPath },
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: false,
        },
      }),
    );

    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await initKuzuDb(kuzuPath);

    const conn = await getKuzuConn();
    const now = "2026-03-07T12:00:00.000Z";

    await kuzuDb.upsertRepo(conn, {
      repoId: "repo-test",
      rootPath: tempDir,
      configJson: JSON.stringify({
        repoId: "repo-test",
        rootPath: tempDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
      }),
      createdAt: now,
    });

    await kuzuDb.upsertFile(conn, {
      fileId: "file-demo",
      repoId: "repo-test",
      relPath: "src/example.ts",
      contentHash: "hash-file-demo",
      language: "ts",
      byteSize: 120,
      lastIndexedAt: now,
    });

    await kuzuDb.upsertSymbol(conn, {
      symbolId: "sym-demo",
      repoId: "repo-test",
      fileId: "file-demo",
      kind: "function",
      name: "demoWindow",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 4,
      rangeEndCol: 1,
      astFingerprint: "fp-demo-window",
      signatureJson: JSON.stringify({ name: "demoWindow", params: [] }),
      summary: "Demo code window target",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeKuzuDb();

    if (originalSDLConfig === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = originalSDLConfig;
    }
    if (originalSDLConfigPath === undefined) {
      delete process.env.SDL_CONFIG_PATH;
    } else {
      process.env.SDL_CONFIG_PATH = originalSDLConfigPath;
    }

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Only mock/restore PolicyEngine between each test — no DB churn.
  beforeEach(() => {
    originalEvaluate = PolicyEngine.prototype.evaluate;
    originalGenerateNextBestAction = PolicyEngine.prototype.generateNextBestAction;
  });

  afterEach(() => {
    PolicyEngine.prototype.evaluate = originalEvaluate;
    PolicyEngine.prototype.generateNextBestAction = originalGenerateNextBestAction;
  });

  it("returns the policy-layer nextBestAction when the gate approves but policy denies", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-test",
        deniedReasons: ["Raw code access denied by custom policy"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "requestHotPath",
        requiredFieldsForNext: {
          requestHotPath: {
            repoId: "repo-test",
            symbolId: "sym-demo",
            identifiersToFind: ["importantFlag"],
            maxTokens: 96,
          },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "inspect important flag handling",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial response");
    assert.deepStrictEqual(response.whyDenied, [
      "Raw code access denied by custom policy",
    ]);
    assert.equal(response.suggestedNextRequest, undefined);
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.getHotPath",
      args: {
        repoId: "repo-test",
        symbolId: "sym-demo",
        identifiersToFind: ["importantFlag"],
        maxTokens: 96,
      },
      rationale: "Raw code access denied by custom policy",
    });
  });

  it("requestSkeleton NBA forwards identifiersToFind from the original request", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-skeleton",
        deniedReasons: ["Too broad"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "requestSkeleton",
        requiredFieldsForNext: {
          requestSkeleton: { repoId: "repo-test", symbolId: "sym-demo" },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "need skeleton",
      expectedLines: 10,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.getSkeleton",
      args: { repoId: "repo-test", symbolId: "sym-demo", identifiersToFind: ["importantFlag"] },
      rationale: "Too broad",
    });
  });

  it("requestRaw NBA rebuilds needWindow args from requiredFieldsForNext", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-raw",
        deniedReasons: ["Needs narrower scope"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "requestRaw",
        requiredFieldsForNext: {
          requestRaw: {
            repoId: "repo-test",
            symbolId: "sym-demo",
            reason: "focus on flag only",
            expectedLines: 5,
            identifiersToFind: ["importantFlag"],
            granularity: "block",
          },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "broad request",
      expectedLines: 50,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.needWindow",
      args: {
        repoId: "repo-test",
        symbolId: "sym-demo",
        reason: "focus on flag only",
        expectedLines: 5,
        identifiersToFind: ["importantFlag"],
        granularity: "block",
      },
      rationale: "Needs narrower scope",
    });
  });

  it("provideIdentifiersToFind NBA with empty examples falls back to gateNextBestAction", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-pif-empty",
        deniedReasons: ["No identifiers provided"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "provideIdentifiersToFind",
        requiredFieldsForNext: {
          provideIdentifiersToFind: { minCount: 1, examples: [] },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "no identifiers",
      expectedLines: 10,
      identifiersToFind: [],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    // fallback is gateNextBestAction; may be undefined when gate also has none
    assert.ok(
      response.nextBestAction === undefined ||
        typeof response.nextBestAction === "object",
      "nextBestAction should be undefined or a callable object (gate fallback)",
    );
    if (response.nextBestAction) {
      assert.notEqual(
        response.nextBestAction.tool,
        "sdl.code.getHotPath",
        "Must not emit getHotPath when examples list is empty",
      );
    }
  });

  it("provideIdentifiersToFind NBA with examples emits getHotPath with those examples", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-pif-examples",
        deniedReasons: ["Must specify identifiers"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "provideIdentifiersToFind",
        requiredFieldsForNext: {
          provideIdentifiersToFind: { minCount: 1, examples: ["importantFlag"] },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "need examples",
      expectedLines: 10,
      identifiersToFind: [],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.getHotPath",
      args: { repoId: "repo-test", symbolId: "sym-demo", identifiersToFind: ["importantFlag"] },
      rationale: "Must specify identifiers",
    });
  });

  it("narrowScope NBA with identifiersToFind emits getHotPath", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-narrow-hp",
        deniedReasons: ["Window too wide"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "narrowScope",
        requiredFieldsForNext: {
          narrowScope: { field: "expectedLines", reason: "Reduce to target function" },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "too wide",
      expectedLines: 100,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.getHotPath",
      args: { repoId: "repo-test", symbolId: "sym-demo", identifiersToFind: ["importantFlag"] },
      rationale: "Reduce to target function",
    });
  });

  it("narrowScope NBA without identifiersToFind emits getSkeleton", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-narrow-sk",
        deniedReasons: ["Window too wide"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "narrowScope",
        requiredFieldsForNext: {
          narrowScope: { field: "expectedLines", reason: "Use skeleton first" },
        },
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "too wide",
      expectedLines: 100,
      identifiersToFind: [],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepStrictEqual(response.nextBestAction, {
      tool: "sdl.code.getSkeleton",
      args: { repoId: "repo-test", symbolId: "sym-demo" },
      rationale: "Use skeleton first",
    });
  });

  it("retryWithSameInputs NBA echoes the original request back as needWindow args", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-retry",
        deniedReasons: ["Transient denial"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return { nextBestAction: "retryWithSameInputs" };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "retry me",
      expectedLines: 20,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    const nba = response.nextBestAction;
    assert.ok(nba, "nextBestAction should be present");
    assert.equal(nba.tool, "sdl.code.needWindow");
    assert.equal((nba.args as Record<string, unknown>).repoId, "repo-test");
    assert.equal((nba.args as Record<string, unknown>).symbolId, "sym-demo");
    assert.equal((nba.args as Record<string, unknown>).reason, "retry me");
    assert.deepStrictEqual(
      (nba.args as Record<string, unknown>).identifiersToFind,
      ["importantFlag"],
    );
    assert.equal(nba.rationale, "Transient denial");
  });

  it("requestHotPath NBA falls back when both policy and request have empty identifiersToFind", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-hp-empty",
        deniedReasons: ["Denied"],
      };
    };
    PolicyEngine.prototype.generateNextBestAction = function () {
      return {
        nextBestAction: "requestHotPath",
        // requiredFieldsForNext omitted → falls back to request.identifiersToFind which is also []
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "no identifiers at all",
      expectedLines: 10,
      identifiersToFind: [],
    });

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    // Must NOT emit an invalid getHotPath call with empty identifiersToFind
    if (response.nextBestAction) {
      assert.notEqual(
        response.nextBestAction.tool,
        "sdl.code.getHotPath",
        "Must not emit getHotPath with empty identifiersToFind",
      );
    }
  });
});
