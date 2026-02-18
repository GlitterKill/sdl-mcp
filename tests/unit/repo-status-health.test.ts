import { describe, it } from "node:test";
import assert from "node:assert";
import { RepoStatusResponseSchema } from "../../src/mcp/tools.js";

describe("repo status health fields", () => {
  it("requires health fields on repo status response", () => {
    assert.throws(() =>
      RepoStatusResponseSchema.parse({
        repoId: "sdl-mcp",
        rootPath: ".",
        latestVersionId: "v1",
        filesIndexed: 1,
        symbolsIndexed: 1,
        lastIndexedAt: new Date().toISOString(),
      }),
    );

    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      latestVersionId: "v1",
      filesIndexed: 1,
      symbolsIndexed: 1,
      lastIndexedAt: new Date().toISOString(),
      healthScore: 88,
      healthComponents: {
        freshness: 1,
        coverage: 1,
        errorRate: 1,
        edgeQuality: 1,
      },
      healthAvailable: true,
      watcherHealth: null,
      prefetchStats: {
        enabled: false,
        queueDepth: 0,
        running: false,
        completed: 0,
        cancelled: 0,
        cacheHits: 0,
        cacheMisses: 0,
        wastedPrefetch: 0,
        hitRate: 0,
        wasteRate: 0,
        avgLatencyReductionMs: 0,
        lastRunAt: null,
      },
    });

    assert.strictEqual(parsed.healthScore, 88);
    assert.strictEqual(parsed.healthAvailable, true);
  });
});
