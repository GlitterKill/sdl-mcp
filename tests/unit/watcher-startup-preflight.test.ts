import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertStableIndexStoragePreflight,
  type IndexStorageStabilitySnapshot,
} from "../../dist/indexer/index-storage-preflight.js";
import {
  runStoragePreflightForReadiness,
  startConfiguredWatchers,
} from "../../dist/cli/commands/serve.js";
import { createStartupReadiness } from "../../dist/startup/readiness.js";
import { processWatchedFileChange } from "../../dist/indexer/watcher.js";

const BASELINE: IndexStorageStabilitySnapshot = {
  physicalTotal: 2,
  distinctTotal: 2,
  firstSymbolId: "a",
  lastSymbolId: "z",
  sampleSymbolIds: ["a", "z"],
};

describe("watcher startup storage readiness", () => {
  it("runs two consecutive incident-shaped scans", async () => {
    let calls = 0;
    const result = await assertStableIndexStoragePreflight(
      {} as never,
      async () => {
        calls += 1;
        return { ...BASELINE, sampleSymbolIds: [...BASELINE.sampleSymbolIds] };
      },
    );

    assert.equal(calls, 2);
    assert.deepEqual(result, BASELINE);
  });

  it("rejects count, boundary, and sample instability", async () => {
    const variants: IndexStorageStabilitySnapshot[] = [
      { ...BASELINE, physicalTotal: 3, distinctTotal: 3 },
      { ...BASELINE, lastSymbolId: "y" },
      { ...BASELINE, sampleSymbolIds: ["a", "m", "z"] },
    ];

    for (const second of variants) {
      let call = 0;
      await assert.rejects(
        assertStableIndexStoragePreflight({} as never, async () => {
          call += 1;
          return call === 1 ? BASELINE : second;
        }),
        /unstable/i,
      );
      assert.equal(call, 2);
    }
  });

  it("retains watcher changes while startup readiness is false", async () => {
    const calls: string[] = [];
    await processWatchedFileChange({
      repoId: "demo",
      filePath: "src/demo.ts",
      isWriteReady: () => false,
      coordinator: {
        recordDiskChange() {
          calls.push("admitted");
          return true;
        },
      },
      async indexRepo() {
        calls.push("index");
      },
      async patchSavedFileFn() {
        calls.push("patch");
      },
    });

    assert.deepEqual(calls, ["admitted"]);
  });

  it("closes started watchers and stops verifier work before degrading", async () => {
    const events: string[] = [];
    const readiness = {
      getSnapshot: () => ({
        state: "initializing" as const,
        reason: null,
        watchers: { expected: 0, ready: 0 },
      }),
      isWriteReady: () => false,
      markReady: () => {
        events.push("ready");
      },
      markDegraded: () => {
        events.push("degraded");
      },
    };

    const handles = await startConfiguredWatchers({
      repoIds: ["a", "b"],
      readiness,
      startWatcher: async (repoId, isWriteReady) => {
        events.push(`start:${repoId}:${isWriteReady()}`);
        if (repoId === "b") throw new Error("forced watcher failure");
        return {
          close: async () => {
            events.push(`close:${repoId}`);
          },
          getHealth: () => ({
            repoId,
            running: true,
            stale: false,
            provider: "chokidar" as const,
            watcherMode: "native" as const,
            eventsReceived: 0,
            eventsProcessed: 0,
            errors: 0,
            pendingChanges: 0,
            startedAt: "",
            lastEventAt: null,
            lastSuccessfulReindexAt: null,
            lastHealthCheckAt: "",
          }),
        };
      },
      stopVerifier: async () => {
        events.push("stop-verifier");
      },
    });

    assert.deepEqual(handles, []);
    assert.deepEqual(events, [
      "start:a:false",
      "start:b:false",
      "close:a",
      "stop-verifier",
      "degraded",
    ]);
  });

  it("marks ready only after every watcher starts", async () => {
    const readiness = createStartupReadiness();
    const handles = await startConfiguredWatchers({
      repoIds: ["a", "b"],
      readiness,
      startWatcher: async () => ({
        close: async () => {},
        getHealth: () => {
          throw new Error("not used");
        },
      }),
      stopVerifier: async () => {},
    });

    assert.equal(handles.length, 2);
    assert.deepEqual(readiness.getSnapshot(), {
      state: "ready",
      reason: null,
      watchers: { expected: 2, ready: 2 },
    });
  });

  it("latches preflight failure without running later startup work", async () => {
    const readiness = createStartupReadiness();
    const events: string[] = [];
    const passed = await runStoragePreflightForReadiness(
      readiness,
      2,
      async () => {
        events.push("preflight");
        throw new Error("forced preflight failure");
      },
      () => {
        events.push("degraded-log");
      },
    );
    if (passed) events.push("writer");

    assert.equal(passed, false);
    assert.deepEqual(events, ["preflight", "degraded-log"]);
    assert.deepEqual(readiness.getSnapshot(), {
      state: "degraded",
      reason: "storage_preflight_failed",
      watchers: { expected: 2, ready: 0 },
    });
  });
});
