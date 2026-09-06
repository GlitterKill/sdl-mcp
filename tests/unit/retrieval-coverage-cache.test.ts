import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("scopes repository health snapshots by version, model plan, and generation", async (t) => {
  const coverageDb = await import("../../dist/db/ladybug-retrieval-health.js");
  const extensionCaps = await import("../../dist/db/extension-caps.js");
  const lifecycle = await import("../../dist/retrieval/index-lifecycle.js");
  const ladybugDb = await import("../../dist/db/ladybug-queries.js");
  const derivedState = await import("../../dist/db/ladybug-derived-state.js");
  const jina = "jina-embeddings-v2-base-code";
  const nomic = "nomic-embed-text-v1.5";
  const versions = new Map<string, string | null>([["repo-a", "v1"], ["repo-b", "v1"]]);
  const assessmentCalls: string[] = [];
  let latestVersionCalls = 0;
  let fileSummaryCalls = 0;
  let extensionCalls = 0;
  let showIndexesCalls = 0;
  let vectorEnabled = true;
  const rows = (repoId: string) => ({
    tableState: "present",
    rows: [jina, nomic].map((model) => ({
      repoId, model, symbolId: "symbol",
      embeddingId: `${model}:symbol`,
      embeddingVectorPresent: true, cardHashPresent: true,
      embeddingJinaCodeVecPresent: model === jina,
      embeddingNomicVecPresent: model === nomic,
    })),
  });
  let loadRows = async (repoId: string) => rows(repoId);
  t.mock.module("../../dist/db/ladybug-retrieval-health.js", {
    namedExports: {
      ...coverageDb,
      validateRepoSymbolVectorOwnership: async () => {},
      countCompleteRepoSymbolVectors: async () => 1,
      getEligibleRepoSymbolIds: async () => ["symbol"],
      getRepoSymbolVectorHealthRows: async (_conn: Connection, repoId: string) => {
        assessmentCalls.push(repoId);
        return loadRows(repoId);
      },
      getFileSummaryRetrievalCoverage: async () => {
        fileSummaryCalls += 1;
        return { eligible: 1n, covered: 1n };
      },
    },
  });
  t.mock.module("../../dist/db/extension-caps.js", {
    namedExports: { ...extensionCaps, getExtensionCapabilities: () => {
      extensionCalls += 1;
      return { fts: true, vector: vectorEnabled };
    } },
  });
  t.mock.module("../../dist/retrieval/index-lifecycle.js", {
    namedExports: { ...lifecycle, showIndexesStrict: async () => {
      showIndexesCalls += 1;
      return [];
    } },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: { ...ladybugDb, getLatestVersion: async (_conn: Connection, repoId: string) => {
      latestVersionCalls += 1;
      const versionId = versions.get(repoId);
      return versionId ? { repoId, versionId } : null;
    } },
  });
  t.mock.module("../../dist/db/ladybug-derived-state.js", {
    namedExports: { ...derivedState, getDerivedStateFromConnection: async () => ({
      embeddingLifecycleState: "steady",
    }) },
  });
  const health = await import("../../dist/retrieval/health.js?repository-coverage-cache");
  const check = (repoId: string, config?: Parameters<typeof health.checkRetrievalHealth>[2]) =>
    health.checkRetrievalHealth({} as Connection, repoId, config);
  const invalidate = health.invalidateSymbolRetrievalCoverageCache;

  assert.equal((await check("repo-a")).vectorJinaCode, true);
  vectorEnabled = false;
  assert.equal((await check("repo-a")).vectorJinaCode, false);
  vectorEnabled = true;
  assert.deepEqual(assessmentCalls, ["repo-a"]);
  assert.equal(latestVersionCalls, 2);
  assert.equal(fileSummaryCalls, 2);
  assert.equal(extensionCalls, 2);
  assert.equal(showIndexesCalls, 2);

  await check("repo-a", { symbolEmbeddingModels: [jina, nomic], fileSummaryEmbeddingModels: [] } as never);
  assert.equal(assessmentCalls.length, 2);
  assert.equal(health.getRepositorySymbolVectorHealthSnapshots("repo-a")?.size, 2);
  await check("repo-a");
  await check("repo-b");
  const beforeInvalidation = assessmentCalls.length;
  invalidate("repo-a");
  await check("repo-a");
  await check("repo-b");
  assert.equal(assessmentCalls.length, beforeInvalidation + 1);

  versions.set("repo-a", "v2");
  const beforeVersion = assessmentCalls.length;
  await check("repo-a");
  assert.equal(assessmentCalls.length, beforeVersion + 1);
  versions.set("repo-a", null);
  assert.equal((await check("repo-a")).vectorJinaCode, false);
  const beforeUnversioned = assessmentCalls.length;
  await check("repo-a");
  assert.equal(assessmentCalls.length, beforeUnversioned);

  // A stale in-flight assessment must not replace a newer generation.
  versions.set("repo-a", "v3");
  let release: ((value: ReturnType<typeof rows>) => void) | undefined;
  loadRows = async () => new Promise<ReturnType<typeof rows>>((resolve) => { release = resolve; });
  const oldAssessment = check("repo-a");
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await check("repo-a")).vectorJinaCode, false);
  versions.set("repo-a", "v4");
  loadRows = async (repoId) => rows(repoId);
  assert.equal((await check("repo-a")).vectorJinaCode, true);
  const generation = health.getRepositorySymbolVectorHealthGeneration("repo-a");
  release(rows("repo-a"));
  await oldAssessment;
  assert.equal(health.getRepositorySymbolVectorHealthGeneration("repo-a"), generation);
  assert.equal(health.getRepositorySymbolVectorHealthSnapshot("repo-a", jina)?.versionId, "v4");

  // Failed inspection stays unavailable until an explicit invalidation retries it.
  invalidate("repo-a");
  loadRows = async () => { throw new Error("transient coverage failure"); };
  assert.equal((await check("repo-a")).vectorJinaCode, false);
  loadRows = async (repoId) => rows(repoId);
  assert.equal((await check("repo-a")).vectorJinaCode, false);
  invalidate("repo-a");
  assert.equal((await check("repo-a")).vectorJinaCode, true);
});
