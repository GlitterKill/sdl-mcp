import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ScipConfigSchema } from "../../dist/config/types.js";
import {
  autoIngestScipIndexes,
  runScipIngestInsideIndex,
  scipIngestWillRun,
} from "../../dist/scip/ingestion.js";

describe("SCIP ingestion compatibility hooks", () => {
  it("keeps deprecated refresh auto-ingest hooks as no-ops", async () => {
    const scip = ScipConfigSchema.parse({
      enabled: true,
      autoIngestOnRefresh: true,
      indexes: [{ path: "index.scip", label: "legacy-config" }],
    });
    let progressEvents = 0;
    let failureEvents = 0;

    assert.equal(scipIngestWillRun({ scip }), false);

    const autoResults = await autoIngestScipIndexes(
      "repo-scip-compat",
      scip,
      process.cwd(),
      () => {
        progressEvents += 1;
      },
      () => {
        failureEvents += 1;
      },
    );
    assert.deepEqual(autoResults, []);
    assert.equal(progressEvents, 0);
    assert.equal(failureEvents, 0);

    const insideResult = await runScipIngestInsideIndex({
      repoId: "repo-scip-compat",
      repoRoot: process.cwd(),
      config: { scip },
    });
    assert.deepEqual(insideResult.results, []);
    assert.equal(insideResult.fullyCoveredPaths.size, 0);
    assert.deepEqual(insideResult.generatedIndexes, []);
    assert.deepEqual(insideResult.failures, []);
  });
});
