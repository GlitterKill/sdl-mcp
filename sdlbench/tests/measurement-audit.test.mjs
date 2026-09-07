import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { runCommandAsync, startObservabilityPolling, buildPairedDeltas, runBenchmark, findCodexSessionTokenCounts } from "../src/sdlbench.mjs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("async execution permits snapshots during work and awaits final counters", async () => {
  let calls = 0;
  const server = createServer((_req, res) => res.end(JSON.stringify({ toolVolume: { totalCalls: ++calls } })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const poller = await startObservabilityPolling("http://127.0.0.1:" + server.address().port, "", "repo", { sdlObservabilityPollMs: 20 });
    const result = await runCommandAsync('node -e "setTimeout(() => console.log(42), 150)"', process.cwd(), 3000);
    await poller.stop();
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /42/);
    assert.ok(poller.getDelta().toolVolume_totalCalls >= 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("async execution records nonzero exits and timeouts", async () => {
  assert.equal((await runCommandAsync('node -e "process.exit(7)"', process.cwd(), 3000)).exitCode, 7);
  const result = await runCommandAsync('node -e "setTimeout(() => {}, 10000)"', process.cwd(), 60);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("pairing separates experiments, repetitions, and source conditions", () => {
  const row = { repoId: "r", taskId: "t", agent: "a", model: "m", quality: { passed: true }, tokens: { total: 10 }, workflow: { executionMode: "behavior" } };
  for (const extra of [{ experimentId: "other" }, { repetitionId: "other" }, { provenance: { sourceHash: "changed" } }]) {
    assert.equal(buildPairedDeltas([{ ...row, variant: "baseline" }, { ...row, variant: "sdl", ...extra }]).length, 0);
  }
});

test("unsupported variants and unvalidated warm state fail before execution", async () => {
  await assert.rejects(runBenchmark({ variant: "invented" }), /Unsupported variant/);
  await assert.rejects(runBenchmark({ variant: "sdl", warmSession: true }), /warmSession/);
});

test("Codex usage sums every matching attempt session", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-multi-"));
  try {
    await mkdir(join(root, "sessions"));
    for (const id of ["one", "two"]) {
      await writeFile(join(root, "sessions", id + ".jsonl"), [
        { type: "session_meta", payload: { id, cwd: root } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } } },
      ].map(JSON.stringify).join("\n"));
    }
    const counts = await findCodexSessionTokenCounts({ runRoot: root, sessionsDir: join(root, "sessions") });
    assert.equal(counts.usage.total_tokens, 24);
    assert.equal(counts.sessionFiles.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown failed-attempt costs remain unknown in cost per solved task", async () => {
  const { analyzeSessions } = await import("../src/sdlbench.mjs");
  const summary = analyzeSessions([
    { variant: "baseline", taskId: "a", quality: { passed: true }, cost: { totalUsd: 2 }, tokens: { total: 10 } },
    { variant: "baseline", taskId: "b", quality: { passed: false }, cost: { totalUsd: null }, tokens: null },
  ]);
  const bucket = summary.byVariant.baseline.byExecutionMode.unknown;
  assert.equal(bucket.passRate, 50);
  assert.equal(bucket.knownCostUsd, 2);
  assert.equal(bucket.costPerSolvedTaskUsd, null);
  assert.equal(bucket.missingCostSessions, 1);
});

test("runner filters before execution and preserves failed attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-attempts-"));
  try {
    await mkdir(join(root, "repo"));
    await writeFile(join(root, "repo", "source.txt"), "source");
    const task = { schemaVersion: 1, taskId: "first", repoId: "tiny", category: "test", prompt: "inspect", repo: { sourcePath: "repo" }, context: { raw: "raw", sdl: "sdl" }, verify: { command: "node -e \"process.exit(0)\"" }, solution: { files: {} } };
    await writeFile(join(root, "matrix.json"), JSON.stringify({ tasks: [task, { ...task, taskId: "second" }, { ...task, taskId: "excluded", repoId: "large" }] }));
    await writeFile(join(root, "repos.json"), JSON.stringify({ repos: [{ repoId: "tiny", sizeClass: "tiny" }, { repoId: "large", sizeClass: "large" }] }));
    const result = await runBenchmark({ root, matrixPath: "matrix.json", reposLockPath: "repos.json", sizeClassFilter: "tiny", tokenizerCommand: "node -e \"process.exit(9)\"", resultsPath: "results.jsonl" });
    assert.equal(result.selectedTaskCount, 2);
    assert.equal(result.records.length, 2);
    assert.ok(result.records.every(row => row.status === "error" && row.tokens === null));
    assert.ok(result.records.every(row => row.provenance.sourceHash && row.experimentId));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing provider telemetry cannot hide an ambiguous retry", () => {
  const row = { repoId: "r", taskId: "t", agent: "codex", model: "m", variant: "sdl", experimentId: "e", repetitionId: "1", workflow: { executionMode: "behavior" } };
  assert.throws(() => buildPairedDeltas([
    { ...row, tokens: null, quality: { passed: false } },
    { ...row, tokens: { total: 20, usageSource: "codex_session_token_count" }, quality: { passed: true } },
  ]), /Ambiguous benchmark pair/);
});

test("partial Codex provider counters are unavailable rather than zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-partial-"));
  try {
    await writeFile(join(root, "partial.jsonl"), [
      { type: "session_meta", payload: { id: "partial", cwd: root } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {} } } },
    ].map(JSON.stringify).join("\n"));
    await assert.rejects(findCodexSessionTokenCounts({ runRoot: root, sessionsDir: root }), /Incomplete provider usage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
