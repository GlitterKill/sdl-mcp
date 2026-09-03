import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Connection } from "kuzu";

interface CoverageRow {
  eligible: unknown;
  covered: unknown;
}

const JINA_PROPERTY = "embeddingJinaCodeVec";
const NOMIC_PROPERTY = "embeddingNomicVec";
const fullCoverage = { eligible: 10n, covered: 10n };

describe("retrieval Symbol coverage cache", () => {
  it("scopes reuse and invalidation without caching live capability checks", async (t) => {
    const coverageDb = await import(
      "../../dist/db/ladybug-retrieval-health.js"
    );
    const extensionCaps = await import("../../dist/db/extension-caps.js");
    const indexLifecycle = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");

    const versions = new Map<string, string | null>([
      ["repo-a", "v1"],
      ["repo-b", "v1"],
    ]);
    const symbolCalls: string[] = [];
    let latestVersionCalls = 0;
    let fileSummaryCalls = 0;
    let extensionCalls = 0;
    let showIndexesCalls = 0;
    let symbolLoader = async (
      _repoId: string,
      _property: string,
    ): Promise<CoverageRow> => fullCoverage;

    t.mock.module("../../dist/db/ladybug-retrieval-health.js", {
      namedExports: {
        ...coverageDb,
        getSymbolRetrievalCoverage: async (
          _conn: Connection,
          repoId: string,
          property: string,
        ) => {
          symbolCalls.push(`${repoId}\0${property}`);
          return symbolLoader(repoId, property);
        },
        getFileSummaryRetrievalCoverage: async () => {
          fileSummaryCalls += 1;
          return fullCoverage;
        },
      },
    });
    t.mock.module("../../dist/db/extension-caps.js", {
      namedExports: {
        ...extensionCaps,
        getExtensionCapabilities: () => {
          extensionCalls += 1;
          return { fts: true, vector: true };
        },
      },
    });
    t.mock.module("../../dist/retrieval/index-lifecycle.js", {
      namedExports: {
        ...indexLifecycle,
        showIndexesStrict: async () => {
          showIndexesCalls += 1;
          return [];
        },
      },
    });
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugDb,
        getLatestVersion: async (_conn: Connection, repoId: string) => {
          latestVersionCalls += 1;
          const versionId = versions.get(repoId) ?? null;
          return versionId ? ({ repoId, versionId } as never) : null;
        },
      },
    });

    const health = await import(
      "../../dist/retrieval/health.js?symbol-coverage-cache-contract"
    );
    const invalidate = Reflect.get(
      health,
      "invalidateSymbolRetrievalCoverageCache",
    );
    assert.equal(typeof invalidate, "function");

    const conn = {} as Connection;
    const check = (
      repoId: string,
      config: Parameters<typeof health.checkRetrievalHealth>[2] = undefined,
    ) => health.checkRetrievalHealth(conn, repoId, config);

    await check("repo-a");
    await check("repo-a");
    assert.deepEqual(symbolCalls, [`repo-a\0${JINA_PROPERTY}`]);
    assert.equal(latestVersionCalls, 2);
    assert.equal(fileSummaryCalls, 2);
    assert.equal(extensionCalls, 2);
    assert.equal(showIndexesCalls, 2);

    await check("repo-a", {
      symbolEmbeddingModels: [
        "jina-embeddings-v2-base-code",
        "nomic-embed-text-v1.5",
      ],
      fileSummaryEmbeddingModels: [],
    } as never);
    assert.deepEqual(symbolCalls.slice(-1), [`repo-a\0${NOMIC_PROPERTY}`]);

    await check("repo-b");
    const beforeInvalidation = symbolCalls.length;
    invalidate("repo-a");
    await check("repo-a");
    await check("repo-b");
    assert.equal(symbolCalls.length, beforeInvalidation + 1);
    assert.deepEqual(symbolCalls.slice(-1), [`repo-a\0${JINA_PROPERTY}`]);

    versions.set("repo-a", "v2");
    const beforeVersionChange = symbolCalls.length;
    await check("repo-a");
    assert.equal(symbolCalls.length, beforeVersionChange + 1);

    versions.set("repo-a", null);
    const beforeUnversioned = symbolCalls.length;
    await check("repo-a");
    await check("repo-a");
    assert.equal(symbolCalls.length, beforeUnversioned + 2);

    versions.set("repo-a", "v3");
    invalidate("repo-a");
    let releaseConcurrent: ((row: CoverageRow) => void) | undefined;
    symbolLoader = async () =>
      new Promise<CoverageRow>((resolve) => {
        releaseConcurrent = resolve;
      });
    const beforeConcurrent = symbolCalls.length;
    const concurrentA = check("repo-a");
    while (!releaseConcurrent) await Promise.resolve();
    const concurrentB = check("repo-a");
    releaseConcurrent(fullCoverage);
    await Promise.all([concurrentA, concurrentB]);
    assert.equal(symbolCalls.length, beforeConcurrent + 1);

    versions.set("repo-a", "v4");
    invalidate("repo-a");
    let rejectOld: ((error: Error) => void) | undefined;
    symbolLoader = async () =>
      new Promise<CoverageRow>((_resolve, reject) => {
        rejectOld = reject;
      });
    const oldVersion = check("repo-a");
    while (!rejectOld) await Promise.resolve();

    versions.set("repo-a", "v5");
    symbolLoader = async () => fullCoverage;
    const beforeRace = symbolCalls.length;
    await check("repo-a");
    rejectOld(new Error("old version failed"));
    await oldVersion;
    await check("repo-a");
    assert.equal(symbolCalls.length, beforeRace + 1);

    versions.set("repo-a", "v6");
    invalidate("repo-a");
    let failOnce = true;
    symbolLoader = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("transient coverage failure");
      }
      return fullCoverage;
    };
    const beforeRetry = symbolCalls.length;
    await check("repo-a");
    await check("repo-a");
    assert.equal(symbolCalls.length, beforeRetry + 2);
  });

  it("invalidates Symbol coverage through the shared index-result hook", () => {
    const source = readFileSync(
      join(process.cwd(), "src/indexer/indexer.ts"),
      "utf8",
    );
    assert.match(
      source,
      /import\s*\{\s*invalidateSymbolRetrievalCoverageCache\s*\}\s*from\s*"\.\.\/retrieval\/health\.js";/,
    );

    const start = source.indexOf("function invalidateIndexResultCaches(");
    const end = source.indexOf("\n}", start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    assert.match(
      source.slice(start, end),
      /invalidateSymbolRetrievalCoverageCache\(repoId\)/,
    );
  });
});
