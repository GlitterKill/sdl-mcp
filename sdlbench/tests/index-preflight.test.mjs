import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import * as bench from "../src/sdlbench.mjs";

const fixtureRoot = resolve("sdlbench/tests/fixtures/repo");
const expectedFiles = [
  "math.mjs", "test.mjs", "src/audit.js", "src/cart.js", "src/catalog.js", "src/discounts.js",
  "src/money.js", "src/orders.js", "src/shipping.js",
  "tests/discount-tax.test.mjs", "tests/tiered-checkout.test.mjs",
  "tests/order-audit.test.mjs", "tests/review-report.test.mjs",
];
const config = () => bench.createSdlHttpConfig({
  task: { repoId: "fixture-js" }, runRoot: fixtureRoot, dbPath: "unused.lbug",
  repoMeta: { languageTags: ["javascript"] },
});

test("generated fixture config admits every source and test through the real scanner", async () => {
  assert.equal(typeof bench.preflightSdlConfig, "function");
  const result = await bench.preflightSdlConfig(config(), {
    repoId: "fixture-js", runRoot: fixtureRoot, expectedFiles,
  });
  assert.deepEqual([...result.files].sort(), [...expectedFiles].sort());
  assert.equal(result.semanticMode, "local-embeddings/mock-summaries");
  assert.equal(result.runtimeMaxDurationMs, 30000);
});

test("preflight rejects excluded tests and a config for a different worktree", async () => {
  const restricted = config();
  restricted.repos[0].languages = ["js", "jsx"];
  await assert.rejects(() => bench.preflightSdlConfig(restricted, {
    repoId: "fixture-js", runRoot: fixtureRoot, expectedFiles,
  }), /excluded.*tests\/discount-tax.test.mjs/);
  await assert.rejects(() => bench.preflightSdlConfig(config(), {
    repoId: "fixture-js", runRoot: resolve("sdlbench"), expectedFiles,
  }), /worktree/);
});

const healthyIndex = () => ({
  summaryStats: { failed: 0 }, scip: { failures: [] },
  providerFirstExecution: { status: "executed", coverage: {
    scannedFiles: expectedFiles.length, uncoveredFiles: 0, fullFallbackFiles: 0,
  } },
});
test("readiness rejects generator failures, fallback and missing coverage", () => {
  assert.equal(typeof bench.validateSdlIndexResult, "function");
  const preflight = { files: expectedFiles };
  assert.doesNotThrow(() => bench.validateSdlIndexResult(healthyIndex(), preflight));
  for (const index of [
    { ...healthyIndex(), scip: { failures: [{ stage: "generator-run", message: "Unable to access jarfile" }] } },
    { ...healthyIndex(), providerFirstExecution: { status: "skipped" } },
    { ...healthyIndex(), providerFirstExecution: { status: "executed", coverage: { scannedFiles: 7 } } },
    { ...healthyIndex(), providerFirstExecution: { status: "executed", coverage: { scannedFiles: 11, uncoveredFiles: 1 } } },
    { ...healthyIndex(), summaryStats: { failed: 1 } },
    {},
  ]) assert.throws(() => bench.validateSdlIndexResult(index, preflight), /preflight/);
});

test("setup failures stop before agent execution and preserve failed index evidence", async () => {
  for (const failure of ["wrong-worktree", "generator-run"]) {
    const root = await mkdtemp(join(tmpdir(), "sdlbench-preflight-"));
    const workDir = join(root, "work");
    let indexRequests = 0;
    const server = createServer(async (req, res) => {
      if (req.url === "/api/config") {
        const [entry] = await readdir(workDir);
        const activeConfig = config();
        activeConfig.repos[0].rootPath = failure === "wrong-worktree" ? fixtureRoot : join(workDir, entry);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ validation: { ok: true }, effective: activeConfig }));
      } else {
        indexRequests++;
        const index = healthyIndex();
        index.scip.failures = [{ stage: "generator-run", message: "Unable to access jarfile" }];
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("event: complete\ndata: " + JSON.stringify(index) + "\n\n");
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const matrixPath = join(root, "matrix.json");
      await writeFile(matrixPath, JSON.stringify({ tasks: [{
        schemaVersion: 1, taskId: "preflight", repoId: "fixture-js", category: "bug-fix", prompt: "Fix the fixture.",
        context: { raw: "fixture", sdl: "fixture" },
        repo: { sourcePath: fixtureRoot }, verify: { command: "node test.mjs" },
      }] }));
      const { records: [record] } = await bench.runBenchmark({
        agent: "local", agentCommand: 'node -e "process.exit(99)"',
        executionMode: "behavior", variant: "sdl", matrixPath, workDir,
        resultsPath: join(root, "sessions.jsonl"),
        sdlHttpBaseUrl: "http://127.0.0.1:" + server.address().port,
      });
      assert.equal(record.status, "error");
      assert.equal(record.claimGrade, "none");
      assert.equal(record.artifacts.agent, null);
      assert.match(record.error.message, /preflight/);
      assert.equal(indexRequests, failure === "wrong-worktree" ? 0 : 1);
      if (failure === "generator-run") {
        assert.equal(record.artifacts.sdl.index.scip.failures[0].stage, "generator-run");
        assert.deepEqual(record.artifacts.sdl.preflight.files.sort(), [...expectedFiles].sort());
      }
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("semantic labels distinguish disabled retrieval and summary generation", async () => {
  for (const [enabled, generateSummaries, expected] of [
    [false, true, "disabled-embeddings/disabled-summaries"],
    [true, false, "local-embeddings/disabled-summaries"],
  ]) {
    const disabled = config();
    Object.assign(disabled.semantic, { enabled, generateSummaries });
    const result = await bench.preflightSdlConfig(disabled, { repoId: "fixture-js", runRoot: fixtureRoot });
    assert.equal(result.semanticMode, expected);
  }
});

test("repository generator overrides reach the server configuration without changing defaults", () => {
  const generator = { binary: "C:/patched tools/scip-io.cmd", args: ["--parallel", "1"], autoInstall: false, cacheGeneratedIndexes: false };
  const overridden = bench.createSdlHttpConfig({
    task: { repoId: "moshi" }, runRoot: fixtureRoot, dbPath: "unused.lbug",
    repoMeta: { languageTags: ["java", "kotlin"], scipGenerator: generator },
  });
  assert.equal(overridden.scip.generator.binary, generator.binary);
  assert.deepEqual(overridden.scip.generator.args, ["--parallel", "1"]);
  assert.equal(overridden.scip.generator.autoInstall, false);
  assert.equal(overridden.scip.generator.cacheGeneratedIndexes, false);
  assert.notEqual(config().scip.generator.binary, generator.binary);
});

test("repository-local scip config cannot overwrite a copied project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-generator-config-"));
  try {
    const matrixPath = join(root, "matrix.json");
    const reposLockPath = join(root, "repos.json");
    const original = "[indexer.java]\nbinary = 'original'\n";
    await writeFile(join(root, ".scip-io.toml"), original);
    await writeFile(matrixPath, JSON.stringify({ tasks: [{
      schemaVersion: 1, taskId: "generator-config", repoId: "moshi",
      category: "bug-fix", prompt: "Do not run an agent.",
      context: { raw: "fixture", sdl: "fixture" },
      repo: { sourcePath: root }, verify: { command: "node -e \"process.exit(99)\"" },
    }] }));
    await writeFile(reposLockPath, JSON.stringify({ repos: [{
      repoId: "moshi", scipIoConfig: "[indexer.java]\nbinary = 'replacement'\n",
    }] }));
    const workDir = await mkdtemp(join(tmpdir(), "sdlbench-generator-work-"));
    try {
      const { records: [record] } = await bench.runBenchmark({
        agent: "local", executionMode: "fixture", variant: "sdl",
        matrixPath, reposLockPath, workDir, resultsPath: join(workDir, "results.jsonl"),
      });
      assert.equal(record.status, "error");
      assert.match(record.error.message, /EEXIST/);
      const { readFile } = await import("node:fs/promises");
      assert.equal(await readFile(join(record.artifacts.worktree, ".scip-io.toml"), "utf8"), original);
    } finally { await rm(workDir, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
