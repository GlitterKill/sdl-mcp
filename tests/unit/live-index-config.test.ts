import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AppConfigSchema, LiveIndexConfigSchema } from "../../dist/config/types.js";

describe("live index config", () => {
  it("provides safe defaults for live indexing", () => {
    const config = LiveIndexConfigSchema.parse({});

    assert.deepStrictEqual(config, {
      enabled: true,
      debounceMs: 75,
      idleCheckpointMs: 15_000,
      maxDraftFiles: 200,
      reconcileConcurrency: 1,
      clusterRefreshThreshold: 25,
    });
  });

  it("accepts liveIndex settings in app config", () => {
    const parsed = AppConfigSchema.parse({
      repos: [],
      policy: {},
      liveIndex: {
        enabled: false,
        debounceMs: 120,
        idleCheckpointMs: 30_000,
        maxDraftFiles: 80,
        reconcileConcurrency: 2,
        clusterRefreshThreshold: 40,
      },
    });

    assert.strictEqual(parsed.liveIndex?.enabled, false);
    assert.strictEqual(parsed.liveIndex?.debounceMs, 120);
    assert.strictEqual(parsed.liveIndex?.idleCheckpointMs, 30_000);
  });
});
