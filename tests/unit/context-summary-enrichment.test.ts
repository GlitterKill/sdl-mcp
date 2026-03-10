import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  generateContextSummary,
  renderContextSummary,
} from "../../dist/mcp/summary.js";

const REPO_ID = "test-context-summary-enrichment-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("context summary enrichment", () => {
  const graphDbPath = join(
    __dirname,
    ".lbug-context-summary-enrichment-test-db",
  );
  const symbolMain = `${REPO_ID}-main`;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-context-summary-enrichment",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-context-summary-enrichment",
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
      fileId: "file-1",
      repoId: REPO_ID,
      relPath: "src/main.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: symbolMain,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "main",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 1,
      astFingerprint: `fp-${symbolMain}`,
      signatureJson: null,
      summary: "entry point",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    const clusterId = `${REPO_ID}-cluster-1`;
    await ladybugDb.upsertCluster(conn, {
      clusterId,
      repoId: REPO_ID,
      label: "Cluster 1",
      symbolCount: 1,
      cohesionScore: 0.0,
      versionId: null,
      createdAt: now,
    });
    await ladybugDb.upsertClusterMember(conn, {
      symbolId: symbolMain,
      clusterId,
      membershipScore: 1.0,
    });

    const processId = `${REPO_ID}-process-1`;
    await ladybugDb.upsertProcess(conn, {
      processId,
      repoId: REPO_ID,
      entrySymbolId: symbolMain,
      label: "Process main",
      depth: 0,
      versionId: null,
      createdAt: now,
    });
    await ladybugDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolMain,
      stepOrder: 0,
      role: "entry",
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("includes cluster and process participation for key symbols", async () => {
    const summary = await generateContextSummary({
      repoId: REPO_ID,
      query: "main",
    });
    assert.ok(summary.keySymbols.length >= 1);

    const main = summary.keySymbols.find((s) => s.symbolId === symbolMain);
    assert.ok(main);
    assert.ok(main.cluster);
    assert.ok(main.processes && main.processes.length >= 1);

    const markdown = renderContextSummary(summary, "markdown");
    assert.ok(markdown.includes("cluster:"));
    assert.ok(markdown.includes("processes:"));
  });
});
