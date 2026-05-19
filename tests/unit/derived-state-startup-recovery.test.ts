import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recoverStaleDerivedStateOnStartup } from "../../dist/startup/derived-state-recovery.js";

describe("recoverStaleDerivedStateOnStartup", () => {
  it("re-enqueues stale persisted derived state and reports recovery", async () => {
    const enqueued: Array<{ repoId: string; targetVersionId: string }> = [];
    const logs: string[] = [];

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
      },
    );

    assert.deepEqual(enqueued, [{ repoId: "repo-a", targetVersionId: "v2" }]);
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
});
