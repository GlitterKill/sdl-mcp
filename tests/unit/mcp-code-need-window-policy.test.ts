import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../src/db/kuzu.js";
import * as kuzuDb from "../../src/db/kuzu-queries.js";
import { handleCodeNeedWindow } from "../../src/mcp/tools/code.js";
import { PolicyEngine } from "../../src/policy/engine.js";

describe("code.needWindow policy remediation", () => {
  let tempDir = "";
  let configPath = "";
  let kuzuPath = "";
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;
  let originalEvaluate: typeof PolicyEngine.prototype.evaluate;
  let originalGenerateNextBestAction:
    typeof PolicyEngine.prototype.generateNextBestAction;

  beforeEach(async () => {
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

    configPath = join(tempDir, "sdlmcp.config.json");
    kuzuPath = join(tempDir, "graph.kuzu");
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

    originalEvaluate = PolicyEngine.prototype.evaluate;
    originalGenerateNextBestAction =
      PolicyEngine.prototype.generateNextBestAction;

    await closeKuzuDb();
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
      signatureJson: JSON.stringify({
        name: "demoWindow",
        params: [],
      }),
      summary: "Demo code window target",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    PolicyEngine.prototype.evaluate = originalEvaluate;
    PolicyEngine.prototype.generateNextBestAction = originalGenerateNextBestAction;

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

  it("returns the policy-layer nextBestAction when the gate approves but policy denies", async () => {
    PolicyEngine.prototype.evaluate = function mockEvaluate() {
      return {
        decision: "deny",
        evidenceUsed: [],
        auditHash: "audit-test",
        deniedReasons: ["Raw code access denied by custom policy"],
      };
    };

    PolicyEngine.prototype.generateNextBestAction =
      function mockGenerateNextBestAction() {
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
    if (response.approved) {
      throw new Error("Expected denial response");
    }

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
});
