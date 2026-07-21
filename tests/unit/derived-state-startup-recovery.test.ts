import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { recoverStaleDerivedStateOnStartup } from "../../dist/startup/derived-state-recovery.js";

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
