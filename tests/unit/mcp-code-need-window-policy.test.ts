import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { enforceCodeWindow } from "../../dist/code/enforce.js";
import {
  handleCodeNeedWindow,
  handleGetHotPath,
} from "../../dist/mcp/tools/code.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import {
  GetHotPathRequestSchema,
  GetHotPathResponseSchema,
} from "../../dist/mcp/tools.js";
import { zodSchemaToJsonSchema } from "../../dist/gateway/compact-schema.js";
import { PolicyEngine } from "../../dist/policy/engine.js";

describe("code.needWindow policy remediation", () => {
  // DB is set up once per suite to avoid Windows heap-corruption on multiple LadybugDB close/reopen cycles.
  let tempDir = "";
  let originalSDLConfig: string | undefined;
  let originalSDLConfigPath: string | undefined;
  let originalEvaluate: typeof PolicyEngine.prototype.evaluate;
  let originalGenerateNextBestAction: typeof PolicyEngine.prototype.generateNextBestAction;
  const largeExampleLines = [
    "export class LargeExample {",
    "  registerToolFactory() { return true; }",
    ...Array.from({ length: 24 }, (_, index) =>
      `  filler${index}() { return ${index}; }`,
    ),
    "  registerTool() {",
    "    return true;",
    "  }",
    ...Array.from({ length: 12 }, (_, index) =>
      `  trailing${index}() { return ${index}; }`,
    ),
    "  tailAnchor() { return true; }",
    "}",
  ];

  before(async () => {
    tempDir = mkdtempSync(
      join(tmpdir(), `sdl-mcp-code-window-${process.pid}-`),
    );
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
    writeFileSync(
      join(tempDir, "src", "large-example.ts"),
      largeExampleLines.join("\n"),
    );

    const configPath = join(tempDir, "sdlmcp.config.json");
    const ladybugPath = join(tempDir, "graph.lbug");
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
        graphDatabase: { path: ladybugPath },
        policy: {
          maxWindowLines: 180,
          maxWindowTokens: 1400,
          requireIdentifiers: true,
          allowBreakGlass: false,
        },
        runtime: { artifactBaseDir: join(tempDir, "artifacts") },
      }),
    );

    originalSDLConfig = process.env.SDL_CONFIG;
    originalSDLConfigPath = process.env.SDL_CONFIG_PATH;
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;

    await initLadybugDb(ladybugPath);

    const conn = await getLadybugConn();
    const now = "2026-03-07T12:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
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

    await ladybugDb.upsertFile(conn, {
      fileId: "file-demo",
      repoId: "repo-test",
      relPath: "src/example.ts",
      contentHash: "hash-file-demo",
      language: "ts",
      byteSize: 120,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
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

    await ladybugDb.upsertFile(conn, {
      fileId: "file-large-example",
      repoId: "repo-test",
      relPath: "src/large-example.ts",
      contentHash: "hash-file-large-example",
      language: "ts",
      byteSize: largeExampleLines.join("\n").length,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertSymbol(conn, {
      symbolId: "sym-large-example",
      repoId: "repo-test",
      fileId: "file-large-example",
      kind: "class",
      name: "LargeExample",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: largeExampleLines.length,
      rangeEndCol: 1,
      astFingerprint: "fp-large-example",
      signatureJson: JSON.stringify({ name: "LargeExample" }),
      summary: "Large code window target",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();

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
    originalGenerateNextBestAction =
      PolicyEngine.prototype.generateNextBestAction;
  });

  afterEach(() => {
    PolicyEngine.prototype.evaluate = originalEvaluate;
    PolicyEngine.prototype.generateNextBestAction =
      originalGenerateNextBestAction;
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
    assert.equal(response.status, "denied");
    assert.equal("contentKind" in response, false);
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

  it("returns byte-identical raw delivery contracts for repeated calls", async () => {
    const request = {
      repoId: "repo-test",
      symbolRef: { name: "demoWindow", file: "src/example.ts" },
      reason: "inspect important flag handling",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
    };
    const first = await handleCodeNeedWindow(request);
    const second = await handleCodeNeedWindow(request);

    assert.equal(first.approved, true);
    if (!first.approved) throw new Error("Expected approved response");
    assert.equal(first.status, "approvedRaw");
    assert.equal(first.contentKind, "raw");
    assert.equal(first.downgradedFrom, undefined);
    assert.equal(first.symbolId, "sym-demo");
    assert.match(first.code, /importantFlag/);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("resolves stringified symbolRef targets for raw code windows", async () => {
    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolRef: JSON.stringify({ name: "demoWindow", file: "src/example.ts" }),
      reason: "inspect important flag handling",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approved response");
    assert.equal(response.symbolId, "sym-demo");
    assert.match(response.code, /importantFlag/);
  });

  it("rejects file-path symbolId targets with corrective next calls", async () => {
    await assert.rejects(
      () => handleCodeNeedWindow({
        repoId: "repo-test",
        symbolId: "src/example.ts",
        reason: "inspect important flag handling",
        expectedLines: 20,
        identifiersToFind: ["importantFlag"],
      }),
      (error) => {
        const richError = error as Error & {
          fallbackTools?: string[];
          nextCalls?: Array<{ tool: string; args: Record<string, unknown> }>;
        };
        assert.match(richError.message, /looks like a file path/);
        assert.deepEqual(richError.fallbackTools, [
          "sdl.code.getSkeleton",
          "sdl.symbol.search",
        ]);
        assert.deepEqual(richError.nextCalls?.[0], {
          tool: "sdl.code.getSkeleton",
          args: { repoId: "repo-test", file: "src/example.ts" },
        });
        return true;
      },
    );
  });

  it("stores approved windows behind response.get when responseMode is handle", async () => {
    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "inspect important flag handling",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
      responseMode: "handle",
    }) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(response.action, "response.get");

    const full = await handleResponseGet({
      repoId: "repo-test",
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const content = full.content as Record<string, unknown>;
    assert.equal(content.approved, true);
    assert.equal(content.status, "approvedRaw");
    assert.match(String(content.code), /importantFlag/);
  });

  it("returns same-session code deltas only when a session id is present", async () => {
    const request = {
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "inspect important flag handling",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
      deltaMode: "auto" as const,
    };
    const context = {
      sessionId: "code-window-delta-session",
      sendNotification: async () => {},
      signal: new AbortController().signal,
    };

    const first = await handleCodeNeedWindow(request, context) as Record<string, unknown>;
    const second = await handleCodeNeedWindow(request, context) as Record<string, unknown>;
    const noSessionFirst = await handleCodeNeedWindow(request) as Record<string, unknown>;
    const noSessionSecond = await handleCodeNeedWindow(request) as Record<string, unknown>;

    assert.equal(first.approved, true);
    assert.match(String(first.code), /importantFlag/);
    assert.equal(second.approved, true);
    assert.equal(second.code, "");
    assert.equal((second.delta as Record<string, unknown>).status, "unchanged");
    assert.equal(noSessionFirst.approved, true);
    assert.match(String(noSessionFirst.code), /importantFlag/);
    assert.equal(noSessionSecond.approved, true);
    assert.match(String(noSessionSecond.code), /importantFlag/);
    assert.equal(noSessionSecond.delta, undefined);
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
      args: {
        repoId: "repo-test",
        symbolId: "sym-demo",
        identifiersToFind: ["importantFlag"],
      },
      rationale: "Too broad",
    });
  });

  it("keeps indexed source coordinates separate from skeleton resume progress", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "downgrade-to-skeleton",
        evidenceUsed: [],
        auditHash: "audit-skeleton-range",
        deniedReasons: ["Use structural context first"],
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "inspect structure before raw code",
      expectedLines: 1,
      maxTokens: 120,
      identifiersToFind: [],
    });

    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected skeleton downgrade");
    assert.equal(response.status, "downgraded");
    assert.equal(response.contentKind, "skeleton");
    assert.equal(response.downgradedFrom, "raw-code");
    assert.deepStrictEqual(response.range, {
      startLine: 1,
      startCol: 0,
      endLine: 4,
      endCol: 1,
    });
    assert.deepStrictEqual(response.truncation?.howToResume, {
      type: "cursor",
      value: 1,
      parameter: "skeletonOffset",
    });
  });

  it("labels hot-path policy downgrades as delivered hot-path content", async () => {
    PolicyEngine.prototype.evaluate = function () {
      return {
        decision: "downgrade-to-hotpath",
        evidenceUsed: [],
        auditHash: "audit-hotpath-kind",
        deniedReasons: ["Use targeted context first"],
      };
    };

    const response = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-demo",
      reason: "inspect the important flag branch",
      expectedLines: 20,
      maxTokens: 120,
      identifiersToFind: ["importantFlag"],
    });

    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected hot-path downgrade");
    assert.equal(response.status, "downgraded");
    assert.equal(response.contentKind, "hotPath");
    assert.equal(response.downgradedFrom, "raw-code");
    assert.match(response.code, /importantFlag/);
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
          provideIdentifiersToFind: {
            minCount: 1,
            examples: ["importantFlag"],
          },
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
      args: {
        repoId: "repo-test",
        symbolId: "sym-demo",
        identifiersToFind: ["importantFlag"],
      },
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
          narrowScope: {
            field: "expectedLines",
            reason: "Reduce to target function",
          },
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
      args: {
        repoId: "repo-test",
        symbolId: "sym-demo",
        identifiersToFind: ["importantFlag"],
      },
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

  it("denies requests whose identifiers are missing even when the symbol is already in the slice", async () => {
    const fakeSymbol = {
      symbol_id: "sym-demo",
      repo_id: "repo-test",
      file_id: 0,
      kind: "function" as const,
      name: "demoWindow",
      exported: 1,
      visibility: "public" as const,
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 4,
      range_end_col: 1,
      ast_fingerprint: "fp-demo-window",
      signature_json: JSON.stringify({ name: "demoWindow", params: [] }),
      summary: "Demo code window target",
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2026-03-07T12:00:00.000Z",
    };
    const fakeLoader = {
      loadWindow: async () => ({
        approved: true as const,
        repoId: "repo-test",
        symbolId: "sym-demo",
        file: "src/example.ts",
        range: { startLine: 1, startCol: 0, endLine: 4, endCol: 1 },
        code: "export function demoWindow() {\n  const importantFlag = true;\n  return importantFlag;\n}",
        whyApproved: [],
        estimatedTokens: 30,
      }),
      getSymbol: async () => fakeSymbol,
    };
    const approveDecision = {
      kind: "approve" as const,
      effectiveCaps: { maxWindowLines: 180, maxWindowTokens: 1400 },
      evidenceUsed: [],
      auditHash: "test-hash",
    };
    const response = await enforceCodeWindow(
      {
        repoId: "repo-test",
        symbolId: "sym-demo",
        reason: "inspect flagged branch",
        expectedLines: 20,
        maxTokens: 120,
        identifiersToFind: ["missingIdentifier"],
      },
      approveDecision,
      fakeLoader,
      {
        slice: {
          cards: [{ symbolId: "sym-demo" }],
          frontier: [],
        } as any,
      },
    );

    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.ok(
      response.whyDenied.includes("Identifiers not found in code window"),
      `Expected identifier-miss denial, got: ${response.whyDenied.join(", ")}`,
    );
  });

  it("anchors block windows on a late exact identifier while preserving cursor continuation", async () => {
    const anchored = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-large-example",
      reason: "inspect registerTool implementation",
      expectedLines: 8,
      maxTokens: 500,
      identifiersToFind: ["registerTool"],
      granularity: "block",
    });

    assert.equal(anchored.approved, true);
    if (!anchored.approved) throw new Error("Expected approved response");
    assert.ok(anchored.code.includes("registerTool()"));
    assert.equal(anchored.code.includes("registerToolFactory"), false);

    const continued = await handleCodeNeedWindow({
      repoId: "repo-test",
      symbolId: "sym-large-example",
      reason: "continue after registerTool implementation",
      expectedLines: 8,
      maxTokens: 500,
      identifiersToFind: ["registerTool", "tailAnchor"],
      granularity: "block",
      cursor: largeExampleLines.length - 8,
    });

    assert.equal(continued.approved, true);
    if (!continued.approved) throw new Error("Expected approved continuation");
    assert.ok(continued.code.includes("tailAnchor"));
    assert.equal(continued.code.includes("registerTool()"), false);
  });

  it("documents hot-path identifiers and guides keyword misses to skeleton", async () => {
    const requestJsonSchema = zodSchemaToJsonSchema(
      GetHotPathRequestSchema,
    ) as {
      properties?: Record<string, { description?: string }>;
    };
    const identifierDescription =
      requestJsonSchema.properties?.identifiersToFind?.description ?? "";
    assert.match(identifierDescription, /AST identifier names/i);
    assert.match(identifierDescription, /keywords|arbitrary text/i);

    const response = await handleGetHotPath({
      repoId: "repo-test",
      symbolId: "sym-demo",
      identifiersToFind: ["return"],
    }) as Record<string, unknown>;

    assert.deepStrictEqual(response.missedIdentifiers, ["return"]);
    const missedIdentifierHint = String(response.missedIdentifierHint ?? "");
    assert.match(missedIdentifierHint, /keyword/i);
    assert.match(missedIdentifierHint, /sdl\.code\.getSkeleton/);

    const parsed = GetHotPathResponseSchema.parse(response) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.missedIdentifierHint, missedIdentifierHint);
  });
});
