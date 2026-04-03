import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleRepoOverview } from "../../dist/mcp/tools/repo.js";
import { handleContextSummary } from "../../dist/mcp/tools/summary.js";
import {
  handleGetHotPath,
  handleGetSkeleton,
} from "../../dist/mcp/tools/code.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import { contextEngine } from "../../dist/agent/context-engine.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

const REPO_ID = "conditional-cache-tools-repo";
const graphDbPath = join(tmpdir(), `.lbug-${REPO_ID}-${process.pid}`);
const repoRoot = join(tmpdir(), `${REPO_ID}-workspace-${process.pid}`);
const relPath = "src/example.ts";
const filePath = join(repoRoot, relPath);
const fileId = `${REPO_ID}-file-1`;
const symbolId = `${REPO_ID}-symbol-1`;

describe("conditional cache-aware tool handlers", () => {
  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });
    mkdirSync(join(repoRoot, "src"), { recursive: true });

    writeFileSync(
      filePath,
      [
        "export function greet(name: string): string {",
        "  const message = buildMessage(name);",
        "  return message.toUpperCase();",
        "}",
        "",
        "function buildMessage(name: string): string {",
        "  return `hello ${name}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: repoRoot,
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: repoRoot,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId,
      repoId: REPO_ID,
      relPath,
      contentHash: "content-hash-1",
      language: "ts",
      byteSize: 160,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId,
      repoId: REPO_ID,
      fileId,
      kind: "function",
      name: "greet",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 4,
      rangeEndCol: 1,
      astFingerprint: "fp-greet",
      signatureJson: JSON.stringify({
        name: "greet",
        params: [{ name: "name", type: "string" }],
        returns: "string",
      }),
      summary: "Formats a greeting.",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    mock.restoreAll();
    await closeLadybugDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.overview returns notModified when ifNoneMatch matches", async () => {
    const first = await handleRepoOverview({
      repoId: REPO_ID,
      level: "stats",
    });
    assert.ok("etag" in first);

    const second = await handleRepoOverview({
      repoId: REPO_ID,
      level: "stats",
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("context.summary returns notModified when ifNoneMatch matches", async () => {
    const first = await handleContextSummary({
      repoId: REPO_ID,
      query: "greet",
      scope: "symbol",
    });
    assert.ok("etag" in first);

    const second = await handleContextSummary({
      repoId: REPO_ID,
      query: "greet",
      scope: "symbol",
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("code.getSkeleton returns notModified when ifNoneMatch matches", async () => {
    const first = await handleGetSkeleton({
      repoId: REPO_ID,
      symbolId,
    });
    assert.ok("etag" in first);

    const second = await handleGetSkeleton({
      repoId: REPO_ID,
      symbolId,
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("code.getHotPath returns notModified when ifNoneMatch matches", async () => {
    const first = await handleGetHotPath({
      repoId: REPO_ID,
      symbolId,
      identifiersToFind: ["buildMessage"],
    });
    assert.ok("etag" in first);

    const second = await handleGetHotPath({
      repoId: REPO_ID,
      symbolId,
      identifiersToFind: ["buildMessage"],
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("agent.context returns notModified when ifNoneMatch matches", async () => {
    mock.method(contextEngine, "buildContext", async () => ({
      taskId: "task-1",
      taskType: "debug" as const,
      actionsTaken: [
        {
          id: "action-1",
          type: "getCard",
          status: "completed",
          input: { symbolId: "sym-1" },
          output: { ok: true },
          timestamp: 1,
          durationMs: 2,
          evidence: [],
        },
      ],
      path: {
        rungs: ["card"],
        estimatedTokens: 50,
        estimatedDurationMs: 10,
        reasoning: "stable",
      },
      finalEvidence: [
        {
          type: "symbolCard",
          reference: "symbol:sym-1",
          summary: "stable summary",
          timestamp: 1,
        },
      ],
      summary: "stable summary",
      success: true,
      metrics: {
        totalDurationMs: 25,
        totalTokens: 10,
        totalActions: 1,
        successfulActions: 1,
        failedActions: 0,
        cacheHits: 0,
      },
      answer: "answer",
      nextBestAction: "none",
      retrievalEvidence: {
        symptomType: "taskText",
      },
    }));

    const first = await handleAgentContext({
      repoId: REPO_ID,
      taskType: "debug",
      taskText: "inspect greet",
    });
    assert.ok("etag" in first);

    const second = await handleAgentContext({
      repoId: REPO_ID,
      taskType: "debug",
      taskText: "inspect greet",
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });

  it("agent.context ignores nested evidence timestamps when computing etags", async () => {
    let callCount = 0;
    mock.method(contextEngine, "buildContext", async () => {
      callCount += 1;
      return {
        taskId: `task-${callCount}`,
        taskType: "debug" as const,
        actionsTaken: [
          {
            id: `action-${callCount}`,
            type: "getCard",
            status: "completed",
            input: { symbolId: "sym-1" },
            output: { ok: true },
            timestamp: callCount,
            durationMs: 2,
            evidence: [
              {
                type: "symbolCard",
                reference: "symbol:sym-1",
                summary: "stable summary",
                timestamp: callCount,
              },
            ],
          },
        ],
        path: {
          rungs: ["card"],
          estimatedTokens: 50,
          estimatedDurationMs: 10,
          reasoning: "stable",
        },
        finalEvidence: [
          {
            type: "symbolCard",
            reference: "symbol:sym-1",
            summary: "stable summary",
            timestamp: callCount,
          },
        ],
        summary: "stable summary",
        success: true,
        metrics: {
          totalDurationMs: 25,
          totalTokens: 10,
          totalActions: 1,
          successfulActions: 1,
          failedActions: 0,
          cacheHits: 0,
        },
        answer: "answer",
        nextBestAction: "none",
        retrievalEvidence: {
          symptomType: "taskText",
        },
      };
    });

    const first = await handleAgentContext({
      repoId: REPO_ID,
      taskType: "debug",
      taskText: "inspect greet",
    });
    assert.ok("etag" in first);

    const second = await handleAgentContext({
      repoId: REPO_ID,
      taskType: "debug",
      taskText: "inspect greet",
      ifNoneMatch: first.etag,
    });

    assert.deepStrictEqual(second, {
      notModified: true,
      etag: first.etag,
    });
  });
});
