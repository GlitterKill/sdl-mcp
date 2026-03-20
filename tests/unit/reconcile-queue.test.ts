import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReconcileQueue } from "../../src/live-index/reconcile-queue.js";

describe("ReconcileQueue", () => {
  it("coalesces repeated enqueue requests per repo and tracks status", () => {
    const queue = new ReconcileQueue();

    queue.enqueue(
      "demo-repo",
      {
        touchedSymbolIds: ["sym-a"],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/b.ts"],
        importedFilePaths: ["src/c.ts"],
        invalidations: ["metrics"],
      },
      "2026-03-07T12:00:00.000Z",
    );
    queue.enqueue(
      "demo-repo",
      {
        touchedSymbolIds: ["sym-b"],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/b.ts", "src/d.ts"],
        importedFilePaths: [],
        invalidations: ["clusters"],
      },
      "2026-03-07T12:01:00.000Z",
    );

    const claimed = queue.claimNext();
    assert.ok(claimed);
    assert.deepStrictEqual(claimed?.frontier.dependentFilePaths, [
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
    assert.deepStrictEqual(claimed?.frontier.touchedSymbolIds, [
      "sym-a",
      "sym-b",
    ]);
    assert.deepStrictEqual(claimed?.frontier.invalidations, [
      "clusters",
      "metrics",
    ]);

    queue.complete("demo-repo", "2026-03-07T12:02:00.000Z");
    const status = queue.getStatus("demo-repo");
    assert.strictEqual(status.queueDepth, 0);
    assert.strictEqual(status.lastSuccessfulReconcileAt, "2026-03-07T12:02:00.000Z");
    assert.strictEqual(status.inflight, false);
  });

  it("counts symbol-only and invalidation-only work in queue depth", () => {
    const queue = new ReconcileQueue();

    queue.enqueue(
      "demo-repo",
      {
        touchedSymbolIds: ["sym-a"],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: ["metrics"],
      },
      "2026-03-07T12:00:00.000Z",
    );

    const status = queue.getStatus("demo-repo");
    assert.strictEqual(status.queueDepth, 2);
  });
});
