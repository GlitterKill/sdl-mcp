import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBenchmark } from "../src/sdlbench.mjs";

async function fakeTokenizer(root) {
  const path = join(root, "fake-tokenizer.mjs");
  await writeFile(path, `
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    const counts = Object.fromEntries(Object.entries(input.texts).map(([key, text]) => [key, String(text).trim().split(/\\s+/).filter(Boolean).length]));
    console.log(JSON.stringify({ counts, encoding: input.encoding, modelHint: input.modelHint, tokenizerVersion: "fake-tiktoken-1.0", tokenizerSource: "tiktoken" }));
  `);
  return `node ${JSON.stringify(path)}`;
}

test("fixture suite contains longer agentic workflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-complex-"));

  try {
    const result = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
    });
    const records = (await readFile(join(root, "sessions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(result.records.length, 4);
    assert.equal(records.length, 4);
    assert.ok(records.every((record) => record.status === "pass"));
    assert.ok(records.some((record) => record.taskId === "feature-tiered-checkout" && record.workflow.filesChanged >= 3));
    assert.ok(records.some((record) => record.taskId === "security-order-audit" && record.workflow.filesChanged >= 2));
    assert.ok(records.some((record) => record.taskId === "review-checkout-risk" && record.artifacts.verifyStdout.includes("review-ok")));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
