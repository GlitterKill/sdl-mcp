import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";

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

    queue.complete(claimed, "2026-03-07T12:02:00.000Z");
    const status = queue.getStatus("demo-repo");
    assert.strictEqual(status.queueDepth, 0);
    assert.strictEqual(
      status.lastSuccessfulReconcileAt,
      "2026-03-07T12:02:00.000Z",
    );
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

it("keeps saved 13 when saved 12 settles after being superseded", () => {
  const queue = new ReconcileQueue();
  const frontier = {
    touchedSymbolIds: [],
    dependentSymbolIds: [],
    dependentFilePaths: ["src/a.ts"],
    importedFilePaths: [],
    invalidations: [],
  };
  queue.enqueue("repo", frontier, "2026-09-05T00:00:00Z", {
    "src/a.ts": { kind: "saved", content: "saved 12", sourceHash: "hash12" },
  });
  const twelve = queue.claimNext();
  assert.ok(twelve);
  assert.deepEqual(twelve.files?.[0]?.input, {
    kind: "saved",
    content: "saved 12",
    sourceHash: "hash12",
  });
  queue.enqueue("repo", frontier, "2026-09-05T00:00:01Z", {
    "src/a.ts": { kind: "saved", content: "saved 13", sourceHash: "hash13" },
  });
  assert.equal(queue.isCurrent(twelve), false);
  queue.complete(twelve, "2026-09-05T00:00:02Z");
  const thirteen = queue.claimNext();
  assert.ok(thirteen);
  assert.deepEqual(thirteen.files[0].input, {
    kind: "saved",
    content: "saved 13",
    sourceHash: "hash13",
  });
  assert.notEqual(thirteen.files[0].generation, twelve.files[0].generation);
  assert.equal(queue.isCurrent(twelve), false);
});

const queuedAt = "2026-09-05T00:00:00Z";
function frontier(...paths: string[]) {
  return {
    touchedSymbolIds: [],
    dependentSymbolIds: [],
    dependentFilePaths: paths,
    importedFilePaths: [],
    invalidations: [],
  };
}
const saved = (content: string) => ({
  kind: "saved" as const,
  content,
  sourceHash: content,
});

it("coalesces hash-known duplicate saves but unknown watcher events invalidate immediately", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("src/a.ts"), queuedAt, {
    "src/a.ts": saved("one"),
  });
  const first = queue.claimNext()!;
  queue.enqueue("repo", frontier("src\\a.ts"), queuedAt, {
    "src\\a.ts": saved("one"),
  });
  assert.equal(queue.isCurrent(first), true);
  queue.enqueue("repo", frontier("src/a.ts"), queuedAt, {
    "src/a.ts": { kind: "disk-change" },
  });
  assert.equal(queue.isCurrent(first), false);
  queue.complete(first, queuedAt);
  const disk = queue.claimNext()!;
  assert.deepEqual(disk.files[0].input, { kind: "disk-change" });
  queue.complete(disk, queuedAt);
  assert.equal(queue.claimNext(), null);
});

it("does not let stale failure or late settlement acknowledge a newer claim", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts"), queuedAt, { "a.ts": saved("12") });
  const old = queue.claimNext()!;
  queue.enqueue("repo", frontier("a.ts"), queuedAt, { "a.ts": saved("13") });
  queue.fail(old, queuedAt, "old failure");
  const latest = queue.claimNext()!;
  assert.equal(latest.files[0].input.content, "13");
  queue.complete(old, queuedAt);
  queue.fail(old, queuedAt, "late failure");
  assert.equal(queue.isCurrent(latest), true);
  queue.complete(latest, queuedAt);
  assert.equal(queue.getStatus("repo").queueDepth, 0);
});

it("retains a failed file while its sibling completes without spinning", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts", "b.ts"), queuedAt);
  const claim = queue.claimNext()!;
  queue.settleFile(claim, "a.ts", "blocked", "unsupported parser");
  queue.complete(claim, queuedAt);
  assert.equal(queue.getStatus("repo").queueDepth, 1);
  assert.equal(queue.peekNext(), false);
  queue.enqueue("repo", frontier("c.ts"), queuedAt);
  const sibling = queue.claimNext()!;
  assert.deepEqual(sibling.frontier.dependentFilePaths, ["c.ts"]);
  queue.complete(sibling, queuedAt);
  assert.equal(queue.getStatus("repo").queueDepth, 1);
  queue.wake("repo", "a.ts"); // Caller observed the missing prerequisite become available.
  assert.deepEqual(queue.claimNext()!.frontier.dependentFilePaths, ["a.ts"]);
});

it("only retries transient failure after settlement and a qualifying wakeup", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts"), queuedAt);
  const claim = queue.claimNext()!;
  queue.wake("repo", "a.ts");
  queue.fail(claim, queuedAt, "temporarily unavailable", "transient");
  assert.equal(queue.claimNext(), null);
  queue.wake("repo", "a.ts");
  assert.ok(queue.claimNext());
});

it("never reuses tokens after close/reopen or per-file state retirement", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts"), queuedAt);
  const first = queue.claimNext()!;
  queue.clearRepo("repo");
  queue.enqueue("repo", frontier("a.ts"), queuedAt);
  const reopened = queue.claimNext()!;
  assert.notEqual(first.files[0].generation, reopened.files[0].generation);
  queue.complete(first, queuedAt);
  assert.equal(queue.isCurrent(reopened), true);
  queue.complete(reopened, queuedAt);
  queue.enqueue("repo", frontier("a.ts"), queuedAt);
  const next = queue.claimNext()!;
  assert.notEqual(next.files[0].generation, reopened.files[0].generation);
});

it("invalidates multi-file preparation and preserves unchanged dependency sources for requeue", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts", "b.ts"), queuedAt, {
    "a.ts": saved("a"),
    "b.ts": saved("b"),
  });
  const claim = queue.claimNext()!;
  queue.enqueue("repo", frontier("a.ts"), queuedAt, { "a.ts": saved("new a") });
  assert.equal(queue.isCurrent(claim), false);
  queue.complete(claim, queuedAt);
  const next = queue.claimNext()!;
  assert.deepEqual(
    next.files.map((file) => file.input.content),
    ["new a", "b"],
  );
  queue.enqueue("repo", frontier("b.ts"), queuedAt); // Dependency inputs changed, source stayed equal.
  assert.equal(queue.isCurrent(next), false);
  queue.complete(next, queuedAt);
  const dependency = queue.claimNext()!;
  assert.deepEqual(
    dependency.files.find((file) => file.filePath === "b.ts")!.input,
    saved("b"),
  );
});

it("coalesces overflow into retained inventory work and invalidates prepared claims", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("prepared.ts"), queuedAt);
  const prepared = queue.claimNext()!;
  queue.enqueue(
    "repo",
    frontier(
      ...Array.from({ length: 10_001 }, (_, index) => `file${index}.ts`),
    ),
    queuedAt,
  );
  assert.equal(queue.isCurrent(prepared), false);
  queue.complete(prepared, queuedAt);
  const inventory = queue.claimNext()!;
  assert.equal(inventory.inventoryNeeded, true);
  assert.ok(inventory.files.length <= 10_000);
  queue.fail(inventory, queuedAt, "inventory unavailable", "transient");
  assert.equal(queue.peekNext(), false);
  assert.ok(queue.getStatus("repo").queueDepth > 0);
  queue.wake("repo");
  const retry = queue.claimNext()!;
  assert.equal(retry.inventoryNeeded, true);
  queue.complete(inventory, queuedAt);
  assert.equal(queue.isCurrent(retry), true);
});

it("reports overflow admission so callers cannot acknowledge an unretained save snapshot", () => {
  const queue = new ReconcileQueue();
  queue.enqueue(
    "repo",
    frontier(...Array.from({ length: 10_000 }, (_, i) => `file${i}.ts`)),
    queuedAt,
  );
  assert.equal(
    queue.enqueue("repo", frontier("overflow.ts"), queuedAt, {
      "overflow.ts": saved("not on disk"),
    }),
    false,
  );
  assert.equal(queue.claimNext()!.inventoryNeeded, true);
});

it("retains explicit removal input after the older save settles", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", frontier("a.ts"), queuedAt, { "a.ts": saved("old") });
  const old = queue.claimNext()!;
  queue.enqueue("repo", frontier("a.ts"), queuedAt, {
    "a.ts": { kind: "removed" },
  });
  queue.complete(old, queuedAt);
  assert.deepEqual(queue.claimNext()!.files[0].input, { kind: "removed" });
});
