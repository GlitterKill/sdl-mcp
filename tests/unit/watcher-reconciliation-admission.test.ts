import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  admitWatcherEvent,
  chokidarRawEvent,
} from "../../dist/indexer/watcher.js";
import { watchmanFileChangeEvent } from "../../dist/indexer/watchman-provider.js";
import { RepoConfigSchema } from "../../dist/config/types.js";

const root = resolve("watcher-classification");
const config = RepoConfigSchema.parse({
  repoId: "repo",
  rootPath: root,
  languages: ["ts"],
  tsconfigPath: "custom/build-settings.json",
});
describe("watcher event admission", () => {
  function fixture() {
    const calls: unknown[] = [];
    const coordinator = {
      recordDiskChange(input: unknown) {
        calls.push(input);
        return true;
      },
      invalidateSourceContext(repoId: string) {
        calls.push(["invalidate", repoId]);
      },
      requestReconcileInventory(repoId: string, options?: unknown) {
        calls.push(["inventory", repoId, options]);
        return true;
      },
    };
    return {
      calls,
      params: {
        repoId: "repo",
        repoRoot: root,
        repoConfig: config,
        extensions: [".ts"],
        compiledIgnorePatterns: [/^ignored\//],
        coordinator,
      },
    };
  }
  it("keeps precise saves and removals when resync follows", () => {
    const { calls, params } = fixture();
    for (const event of [
      { type: "path", relativePath: "src/a.ts" },
      { type: "path", relativePath: "src/old.ts", removed: true },
      { type: "resync", reason: "recrawl" },
      { type: "path", relativePath: "src/a.ts" },
    ] as const)
      assert.equal(admitWatcherEvent({ ...params, event }), true);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[1], {
      repoId: "repo",
      filePath: "src/old.ts",
      removed: true,
    });
    assert.deepEqual(calls[2], ["inventory", "repo", undefined]);
  });
  it("invalidates config ownership before forced inventory even without a source suffix", () => {
    for (const relativePath of [
      "package.json",
      "bun.lockb",
      "custom/build-settings.json",
    ]) {
      const { calls, params } = fixture();
      assert.equal(
        admitWatcherEvent({ ...params, event: { type: "path", relativePath } }),
        true,
      );
      assert.deepEqual(calls, [
        ["invalidate", "repo"],
        ["inventory", "repo", { force: true }],
      ]);
    }
  });
  it("routes ambiguous and recovery events to inventory while filtering irrelevant files", () => {
    const { calls, params } = fixture();
    for (const event of [
      { type: "path", relativePath: "" },
      { type: "path", relativePath: "../outside.ts" },
      ...["ready", "restart", "directory", "handoff"].map((reason) => ({
        type: "resync" as const,
        reason,
      })),
    ] as const)
      assert.equal(admitWatcherEvent({ ...params, event }), true);
    for (const relativePath of ["README.md", "ignored/a.ts"])
      assert.equal(
        admitWatcherEvent({ ...params, event: { type: "path", relativePath } }),
        null,
      );
    assert.equal(calls.length, 6);
  });
  it("ignores Watchman directory churn but recovers malformed names", () => {
    const { calls, params } = fixture();
    params.compiledIgnorePatterns = [/^node_modules(?:\/|$)/, /^build(?:\/|$)/];
    for (const name of ["node_modules", "node_modules/dep", "build/generated"])
      assert.equal(
        admitWatcherEvent({
          ...params,
          event: watchmanFileChangeEvent(
            { name, type: "d" },
            { watchRoot: root },
          ),
        }),
        null,
      );
    for (const file of [
      {},
      { name: "../invalid.ts" },
      { name: "src/new", type: "d" },
    ])
      assert.equal(
        admitWatcherEvent({
          ...params,
          event: watchmanFileChangeEvent(file, { watchRoot: root }),
        }),
        true,
      );
    assert.equal(calls.length, 3);
  });

  it("maps raw directory and file watches without waiting for normalized changes", () => {
    const { calls, params } = fixture();
    const directory = resolve(root, "src");
    const file = resolve(directory, "a.ts");
    const dirs = new Set([directory.replace(/\\/g, "/")]);
    for (const watchedPath of [directory, file]) {
      const event = chokidarRawEvent("change", "a.ts", { watchedPath }, dirs);
      assert.equal(admitWatcherEvent({ ...params, event }), true);
    }
    assert.deepEqual(calls, [
      { repoId: "repo", filePath: "src/a.ts" },
      { repoId: "repo", filePath: "src/a.ts" },
    ]);
    for (const event of [
      chokidarRawEvent("change", null, {}, dirs),
      chokidarRawEvent("change", "a.ts", {}, dirs),
      chokidarRawEvent("rename", file, {}, dirs),
    ])
      assert.equal(event.type, "resync");
  });
});
