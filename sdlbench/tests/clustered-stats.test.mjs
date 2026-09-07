import test from "node:test";
import assert from "node:assert/strict";
import { clusteredPairedCI } from "../src/stats.mjs";

test("repeated pairs do not inflate independent task count or task weight", () => {
  const rows = [
    ...Array.from({ length: 9 }, () => ({ repoId: "a", taskId: "same", deltaPct: 100 })),
    { repoId: "b", taskId: "same", deltaPct: 0 },
  ];
  const result = clusteredPairedCI(rows, "deltaPct");
  assert.equal(result.taskCount, 2);
  assert.equal(result.pairedCount, 10);
  assert.equal(result.mean, 50);
  assert.ok(result.interval.lower >= 0);
  assert.ok(result.interval.upper <= 100);
  assert.ok(result.interval.lower <= result.interval.upper);
});

test("one task across repetitions has a mean but no inferential interval", () => {
  assert.deepEqual(clusteredPairedCI([
    { repoId: "a", taskId: "task", deltaTok: 10 },
    { repoId: "a", taskId: "task", deltaTok: -20 },
  ], "deltaTok"), {
    method: "task-cluster-bootstrap", taskCount: 1, pairedCount: 2,
    mean: -5, interval: null,
  });
});

test("unknown metrics and absent task identity are not fabricated observations", () => {
  assert.deepEqual(clusteredPairedCI([
    { repoId: "a", taskId: "task", deltaPct: null },
    { repoId: "a", taskId: "task", deltaPct: NaN },
    { repoId: "a", taskId: "task", deltaPct: Infinity },
    { taskId: "task", deltaPct: 50 },
  ], "deltaPct"), {
    method: "task-cluster-bootstrap", taskCount: 0, pairedCount: 0,
    mean: null, interval: null,
  });
});
