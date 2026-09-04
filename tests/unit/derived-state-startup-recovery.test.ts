import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  reassessAndPublishAllRepositoryVectorHealth,
  recoverStaleDerivedStateOnStartup,
} from "../../dist/startup/derived-state-recovery.js";
import {
  evaluateRepositorySymbolVectorHealth,
  resolveRequiredRetrievalIndexes,
} from "../../dist/retrieval/health.js";
import { resolveSymbolVectorPhysicalIdentity } from "../../dist/db/ladybug-symbol-embeddings.js";

describe("recoverStaleDerivedStateOnStartup", () => {
  it("starts pending graph revision recovery only after DB migration and repository bootstrap", () => {
    for (const relativePath of ["src/main.ts", "src/cli/commands/serve.ts"]) {
      const source = readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
      const migration = source.indexOf("await initGraphDb(");
      const bootstrap = source.indexOf("await ensureConfiguredReposRegistered(");
      const recovery = source.indexOf("await recoverStaleDerivedStateOnStartup(");
      assert.ok(migration >= 0 && bootstrap > migration, relativePath);
      assert.ok(recovery > bootstrap, relativePath);
    }
  });
  it("re-enqueues stale persisted derived state and reports recovery", async () => {
    const enqueued: Array<{ repoId: string; targetVersionId: string }> = [];
    const logs: string[] = [];
    let verifierRecoveryStarts = 0;

    const result = await recoverStaleDerivedStateOnStartup(
      {
        repos: [
          { repoId: "repo-a" },
          { repoId: "repo-b" },
          { repoId: "repo-c" },
        ],
      },
      (message) => logs.push(message),
      {
        getDerivedStateSummary: async (repoId) => {
          if (repoId === "repo-a") {
            return {
              stale: true,
              structuralStale: true,
              semanticStale: true,
              clustersDirty: true,
              processesDirty: false,
              algorithmsDirty: false,
              summariesDirty: true,
              embeddingsDirty: true,
              targetVersionId: "v2",
              computedVersionId: "v1",
              updatedAt: "2026-05-18T22:57:00.800Z",
            };
          }
          if (repoId === "repo-b") {
            return {
              stale: false,
              structuralStale: false,
              semanticStale: false,
              clustersDirty: false,
              processesDirty: false,
              algorithmsDirty: false,
              summariesDirty: false,
              embeddingsDirty: false,
              targetVersionId: "v2",
              computedVersionId: "v2",
              updatedAt: "2026-05-18T22:57:00.800Z",
            };
          }
          return null;
        },
        enqueueDerivedRefresh: (repoId, targetVersionId) => {
          enqueued.push({ repoId, targetVersionId });
        },
        startGraphIntegrityVerifierRecovery: async () => {
          verifierRecoveryStarts += 1;
        },
      },
    );

    assert.deepEqual(enqueued, [{ repoId: "repo-a", targetVersionId: "v2" }]);
    assert.equal(verifierRecoveryStarts, 1);
    assert.deepEqual(result, {
      checked: 3,
      queued: 1,
      skipped: 2,
      failed: 0,
    });
    assert.match(
      logs.join("\n"),
      /Queued deferred derived-state refresh for repo-a \(target=v2, dirty=clusters, summaries, embeddings\)/,
    );
    assert.match(
      logs.join("\n"),
      /Derived-state recovery: checked 3 repo\(s\), queued 1 stale repo\(s\), skipped 2, failed 0\./,
    );
  });

  it("does not enqueue semantic-only stale state for graph refresh", async () => {
    const enqueued: Array<{ repoId: string; targetVersionId: string }> = [];
    const logs: string[] = [];

    const result = await recoverStaleDerivedStateOnStartup(
      {
        repos: [{ repoId: "repo-semantic-only" }],
      },
      (message) => logs.push(message),
      {
        getDerivedStateSummary: async () => ({
          stale: true,
          structuralStale: false,
          semanticStale: true,
          clustersDirty: false,
          processesDirty: false,
          algorithmsDirty: false,
          summariesDirty: false,
          embeddingsDirty: true,
          targetVersionId: "v3",
          computedVersionId: "v3",
          updatedAt: "2026-05-25T22:00:00.000Z",
        }),
        enqueueDerivedRefresh: (repoId, targetVersionId) => {
          enqueued.push({ repoId, targetVersionId });
        },
        startGraphIntegrityVerifierRecovery: async () => {},
      },
    );

    assert.deepEqual(enqueued, []);
    assert.deepEqual(result, {
      checked: 1,
      queued: 0,
      skipped: 1,
      failed: 0,
    });
    assert.match(
      logs.join("\n"),
      /Semantic readiness remains deferred for repo-semantic-only/,
    );
  });
});


const SYMBOL_MODEL = "jina-embeddings-v2-base-code";

function makeVectorRows(repoId: string, count: number, owned = true) {
  return Array.from({ length: count }, (_, index) => {
    const symbolId = `symbol-${index}`;
    return {
      embeddingId: `${SYMBOL_MODEL}:${symbolId}`,
      repoId: owned ? repoId : "foreign-repo",
      symbolId,
      model: SYMBOL_MODEL,
      embeddingVectorPresent: true,
      cardHashPresent: true,
      embeddingJinaCodeVecPresent: true,
      embeddingNomicVecPresent: false,
    };
  });
}

describe("repository vector startup assessment", () => {
  const semantic = {
    enabled: true,
    symbolEmbeddingModels: [SYMBOL_MODEL],
    fileSummaryEmbeddingModels: [],
  };

  async function assessFixture(options: {
    lifecycleState: "steady" | "refreshing" | "deleting";
    tableState?: "absent" | "present";
    owned?: boolean;
    vectorCount?: number;
    catalogRows?: Array<{
      name: string;
      type: "vector";
      property: string;
      tableName?: string;
      extensionLoaded?: boolean;
      status: "healthy" | "unknown";
    }>;
  }) {
    const repoId = "startup-repo";
    const events: string[] = [];
    const diagnostics: Array<{ code: string; repoId?: string; tableName: string }> = [];
    const published: Array<{ mode: string; reason?: string }> = [];
    const vectorCount = options.vectorCount ?? 1;
    const symbolIds = Array.from({ length: vectorCount }, (_, index) => `symbol-${index}`);

    const repoIds = await reassessAndPublishAllRepositoryVectorHealth(
      {
        repos: [{ repoId }],
        semantic,
      },
      {
        getConnection: async () => ({}) as never,
        listStoredRepoIds: async () => {
          events.push("SHOW STORED REPOSITORIES");
          return [repoId];
        },
        listCachedRepoIds: () => [],
        listVectorTables: async () => {
          events.push("SHOW TABLES");
          return [];
        },
        getLatestVersion: async () => ({ versionId: "v1" }) as never,
        getDerivedState: async () => ({
          repoId,
          targetVersionId: "v1",
          embeddingsDirty: options.lifecycleState !== "steady",
          embeddingLifecycleState: options.lifecycleState,
        }) as never,
        assess: async (_conn, input) =>
          evaluateRepositorySymbolVectorHealth({
            ...input,
            tableState: options.tableState ?? "present",
            eligibleSymbolIds: symbolIds,
            vectorRows: makeVectorRows(repoId, vectorCount, options.owned ?? true),
            indexes: options.catalogRows ?? [],
          }),
        invalidate: (_repoId, _versionId, _semanticConfig, lifecycle) => {
          events.push(`INVALIDATE ${lifecycle}`);
          return 1;
        },
        publish: ({ snapshots }) => {
          published.push(...snapshots);
          return true;
        },
        publishDiagnostics: (next) => diagnostics.push(...next),
      },
    );

    assert.deepEqual(repoIds, [repoId]);
    assert.equal(
      events.some((event) => /^(CREATE|DROP|DELETE|MERGE)\b/.test(event)),
      false,
    );
    return { diagnostics, published };
  }

  for (const testCase of [
    { name: "refreshing", lifecycleState: "refreshing", expectedMode: "degraded" },
    { name: "deleting", lifecycleState: "deleting", expectedMode: "degraded" },
    { name: "missing table", lifecycleState: "steady", tableState: "absent", expectedMode: "degraded" },
  ] as const) {
    it(`publishes ${testCase.name} startup health without mutation`, async () => {
      const result = await assessFixture(testCase);
      assert.equal(result.published[0]?.mode, testCase.expectedMode);
      if (testCase.lifecycleState === "deleting") {
        assert.match(result.published[0]?.reason ?? "", /deletion is pending/);
        assert.equal(result.diagnostics[0]?.code, "deletion-pending");
      }
    });
  }

  it("keeps wrong index identity degraded without mutation", async () => {
    const expected = resolveRequiredRetrievalIndexes(semantic, "startup-repo")
      .symbolVectors[0]!;
    const result = await assessFixture({
      lifecycleState: "steady",
      catalogRows: [{
        name: expected.name!,
        type: "vector",
        property: expected.property!,
        tableName: "SymbolVectorEmbedding_r_wrong",
        extensionLoaded: true,
        status: "healthy",
      }],
    });
    assert.equal(result.published[0]?.mode, "degraded");
  });

  it("publishes healthy exact startup health without mutation", async () => {
    const result = await assessFixture({ lifecycleState: "steady" });
    assert.equal(result.published[0]?.mode, "exact");
  });

  it("publishes healthy HNSW startup health without mutation", async () => {
    const expected = resolveRequiredRetrievalIndexes(semantic, "startup-repo")
      .symbolVectors[0]!;
    const result = await assessFixture({
      lifecycleState: "steady",
      vectorCount: 2_000,
      catalogRows: [{
        name: expected.name!,
        type: "vector",
        property: expected.property!,
        tableName: expected.tableName,
        extensionLoaded: true,
        status: "healthy",
      }],
    });
    assert.equal(result.published[0]?.mode, "hnsw");
  });

  it("assesses the stored/configured union and reports unowned prefix tables", async () => {
    const orphanTable = resolveSymbolVectorPhysicalIdentity("orphan-repo", SYMBOL_MODEL).tableName;
    const diagnostics: Array<{ code: string; repoId?: string; tableName: string }> = [];
    const assessed: string[] = [];

    const repoIds = await reassessAndPublishAllRepositoryVectorHealth(
      {
        repos: [{ repoId: "configured-only" }],
        semantic: { ...semantic, enabled: false },
      },
      {
        getConnection: async () => ({}) as never,
        listStoredRepoIds: async () => ["stored-only"],
        listCachedRepoIds: () => [],
        listVectorTables: async () => [orphanTable],
        getLatestVersion: async (_conn, repoId) => {
          assessed.push(repoId);
          return null;
        },
        getDerivedState: async () => null,
        assess: async () => [],
        invalidate: () => 1,
        publish: () => true,
        publishDiagnostics: (next) => diagnostics.push(...next),
      },
    );

    assert.deepEqual(repoIds, ["configured-only", "stored-only"]);
    assert.deepEqual(assessed, ["configured-only", "stored-only"]);
    assert.deepEqual(
      diagnostics.map(({ code, tableName }) => ({ code, tableName })),
      [{
        code: "orphan-table",
        tableName: orphanTable,
      }],
    );
  });

  it("clears a cached-only repository without reassessing or republishing it", async () => {
    const invalidated: string[] = [];
    const cleared: string[] = [];
    const assessed: string[] = [];
    const published: string[] = [];

    const repoIds = await reassessAndPublishAllRepositoryVectorHealth(
      {
        repos: [],
        semantic: { ...semantic, enabled: false },
      },
      {
        getConnection: async () => ({}) as never,
        listStoredRepoIds: async () => [],
        listCachedRepoIds: () => ["cached-only"],
        listVectorTables: async () => [],
        getLatestVersion: async (_conn, repoId) => {
          assessed.push(repoId);
          return null;
        },
        getDerivedState: async () => null,
        assess: async () => [],
        clear: (repoId) => {
          cleared.push(repoId);
        },
        invalidate: (repoId) => {
          invalidated.push(repoId);
          return 1;
        },
        publish: ({ repoId }) => {
          published.push(repoId);
          return true;
        },
        publishDiagnostics: () => undefined,
      },
    );

    assert.deepEqual(repoIds, []);
    assert.deepEqual(invalidated, ["cached-only"]);
    assert.deepEqual(cleared, ["cached-only"]);
    assert.deepEqual(assessed, []);
    assert.deepEqual(published, []);
  });
});
