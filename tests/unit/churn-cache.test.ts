import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TEST_DB_PATH = join(
  tmpdir(),
  `.lbug-churn-cache-${process.pid}.lbug`,
);

async function resetTestDb(): Promise<void> {
  const { closeLadybugDb, initLadybugDb } = await import("../../dist/db/ladybug.js");
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

describe("churn cache", () => {
  afterEach(async () => {
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("skips repeated HEAD probes inside the hot window but revalidates later", async () => {
    await resetTestDb();

    const repoRoot = join(tmpdir(), `sdl-mcp-churn-cache-${Date.now()}`);
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(join(repoRoot, "src", "metric.ts"), "export const value = 1;\n");

      const { getLadybugConn } = await import("../../dist/db/ladybug.js");
      const queries = await import("../../dist/db/ladybug-queries.js");
      const conn = await getLadybugConn();
      const repoId = "churn-cache-repo";
      const fileId = "churn-cache-file";

      await queries.upsertRepo(conn, {
        repoId,
        rootPath: repoRoot,
        configJson: JSON.stringify({
          repoId,
          rootPath: repoRoot,
          languages: ["ts"],
          ignore: [],
          maxFileBytes: 1024 * 1024,
          includeNodeModulesTypes: false,
        }),
        createdAt: "2026-04-03T00:00:00Z",
      });
      await queries.upsertFile(conn, {
        fileId,
        repoId,
        relPath: "src/metric.ts",
        contentHash: "metric-hash",
        language: "ts",
        byteSize: 10,
        lastIndexedAt: null,
      });
      await queries.upsertSymbol(conn, {
        symbolId: "symbol-metric",
        repoId,
        fileId,
        kind: "function",
        name: "metricValue",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 10,
        astFingerprint: "metric-value",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-04-03T00:00:00Z",
      });

      let revParseCount = 0;
      let logCount = 0;
      let currentHead = "head-1";
      let nowMs = 1_000;

      const metricsModuleUrl = `${pathToFileURL(join(process.cwd(), "dist", "graph", "metrics.js")).href}?churn-cache=${Date.now()}`;
      const {
        _setMetricsGitHooksForTesting,
        updateMetricsForRepo,
      } = await import(metricsModuleUrl);
      _setMetricsGitHooksForTesting({
        now: () => nowMs,
        getCurrentCommitHash: async () => {
          revParseCount++;
          return currentHead;
        },
        getChurnByFile: async () => {
          logCount++;
          return new Map([["src/metric.ts", 2]]);
        },
      });

      await updateMetricsForRepo(repoId);
      assert.equal(revParseCount, 1);
      assert.equal(logCount, 1);

      nowMs = 5_000;
      await updateMetricsForRepo(repoId);
      assert.equal(revParseCount, 1);
      assert.equal(logCount, 1);

      nowMs = 31_000;
      await updateMetricsForRepo(repoId);
      assert.equal(revParseCount, 2);
      assert.equal(logCount, 1);

      currentHead = "head-2";
      nowMs = 62_000;
      await updateMetricsForRepo(repoId);
      assert.equal(revParseCount, 3);
      assert.equal(logCount, 2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
