import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScalingCurve } from "../src/scaling.mjs";

test("scaling selects sizes before execution and counterbalances shared experiment repetitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-scaling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runScalingCurve({
    root, sizeClasses: ["tiny", "small"], iUnderstandCost: true,
    experimentId: "experiment", repetitions: 2,
  }, async (options) => {
    calls.push(options);
    const records = ["repo-a", "repo-b"].map((repoId) => ({
      repoId, repo: { sizeClass: options.sizeClassFilter },
      taskId: "same-task", agent: "codex", model: "fake",
      experimentId: options.experimentId, repetitionId: options.repetitionId,
      variant: options.variant, warmSession: false,
      workflow: { executionMode: options.executionMode },
      quality: { passed: true },
      tokens: { total: options.variant === "baseline" ? 100 : 60 },
    }));
    return { records, selectedTaskCount: records.length };
  });
  assert.deepEqual(calls.map((call) => [call.sizeClassFilter, call.variant]), [
    ["tiny", "baseline"], ["tiny", "sdl"], ["tiny", "sdl"], ["tiny", "baseline"],
    ["small", "baseline"], ["small", "sdl"], ["small", "sdl"], ["small", "baseline"],
  ]);
  assert.ok(calls.every((call) => call.executionMode === "behavior" && call.experimentId === "experiment"));
  assert.deepEqual(calls.map((call) => call.repetitionId), ["0", "0", "1", "1", "0", "0", "1", "1"]);
  assert.equal(result.records.length, 16);
  assert.ok(result.selections.every((selection) => selection.selectedTaskCount === 2));
  assert.equal(result.scalingRows.length, 2);
  for (const row of result.scalingRows) {
    assert.equal(row.pairedCount, 4);
    assert.equal(row.selectedTaskCount, 4);
    assert.equal(row.baselineTok, 400);
    assert.equal(row.productTok, 240);
    assert.equal(row.deltaPct, 40);
  }
  assert.equal((await readFile(result.outputPath, "utf8")).trim().split("\n").length, 2);
});

test("scaling preserves explicit fixture mode and reports empty actual selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-scaling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runScalingCurve({
    root, executionMode: "fixture", sizeClasses: ["tiny"], iUnderstandCost: true,
  }, async (options) => {
    assert.equal(options.executionMode, "fixture");
    assert.equal(options.sizeClassFilter, "tiny");
    return { records: [], selectedTaskCount: 0 };
  });
  assert.deepEqual(result.scalingRows, []);
  assert.deepEqual(result.selections.map((selection) => selection.selectedTaskCount), [0, 0]);
  assert.equal(await readFile(result.outputPath, "utf8"), "");
});

test("scaling cost consent never invents a budget or executes a benchmark", async () => {
  await assert.rejects(runScalingCurve({ root: "." }, () => {
    assert.fail("benchmark must not execute without cost consent");
  }), /Estimated budget: unknown/);
});

test("scaling rejects ambiguous duplicate attempts before excluding failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-scaling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(runScalingCurve({
    root, sizeClasses: ["tiny"], iUnderstandCost: true,
  }, async (options) => {
    const record = {
      repoId: "repo", taskId: "task", variant: options.variant,
      workflow: { executionMode: "behavior" }, quality: { passed: false },
      experimentId: options.experimentId, repetitionId: options.repetitionId,
    };
    return { records: [record, record], selectedTaskCount: 2 };
  }), /Ambiguous benchmark pair/);
});

test("scaling validates every variant before any paid counterpart starts", async () => {
  await assert.rejects(runScalingCurve({
    root: ".", variant: "baseline,unknown", iUnderstandCost: true,
  }, () => assert.fail("unsupported variant must fail before execution")), /Unsupported scaling variant/);
});
