import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ObservabilityConfigSchema } from "../../../dist/config/types.js";
import { ObservabilityService } from "../../../dist/observability/service.js";

function service(): ObservabilityService {
  return new ObservabilityService(ObservabilityConfigSchema.parse({}));
}

describe("ObservabilityService graph event bridge", () => {
  it("bridges existing taps into graph activity events", () => {
    const obs = service();

    obs.indexPhase({ repoId: "repo-a", phase: "started", durationMs: 0 });
    obs.indexEvent({
      repoId: "repo-a",
      versionId: "v1",
      stats: { filesScanned: 3, symbolsExtracted: 4, edgesExtracted: 5, durationMs: 6, errors: 0 },
    });
    obs.scipIngest({ repoId: "repo-a", edgesCreated: 2, edgesUpgraded: 1, durationMs: 7, failed: false });
    obs.sliceBuild({ repoId: "repo-a", durationMs: 8, accepted: 9, evicted: 0, rejected: 1 });
    obs.deltaBlastRadius({
      repoId: "repo-a",
      changedSymbolCount: 10,
      blastRadiusCount: 11,
      durationMs: 12,
      dbRoundTrips: 1,
      fallbackPathQueryCount: 0,
      pathExplanationLatencyMs: 0,
    });

    assert.deepEqual(obs.getRecentGraphEvents().map((event) => event.type), [
      "graph.index.started",
      "graph.index.completed",
      "graph.symbols.upserted",
      "graph.edges.added",
      "graph.slice.built",
      "graph.delta.computed",
    ]);
  });
});
