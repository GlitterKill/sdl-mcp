import assert from "node:assert/strict";
import { activateCliConfigPath } from "../../dist/config/configPath.js";
import { invalidateConfigCache, loadConfig } from "../../dist/config/loadConfig.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

describe("real-world benchmark script", () => {
  it("keeps nightly matrix indexing on the compatibility pipeline", () => {
    const matrix = readFileSync(
      resolve(repoRoot, "scripts/real-world-benchmark-matrix.ts"),
      "utf8",
    );
    const benchmark = readFileSync(
      resolve(repoRoot, "scripts/real-world-benchmark.ts"),
      "utf8",
    );
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

    assert.match(matrix, /getFlag\(args, "force-legacy-index"\)/u);
    assert.match(matrix, /\$\{forceLegacyArg\}/u);
    assert.match(benchmark, /forceLegacyPipeline:\s*forceLegacyIndex/u);
    assert.match(workflow, /benchmark:matrix -- --force-legacy-index/u);
  });

  it("runs the matrix smoke entrypoint without parse or helper reference errors", () => {
    const outDir = mkdtempSync(resolve(tmpdir(), "sdl-mcp-benchmark-smoke-"));
    const result = spawnSync(process.execPath, [
      "scripts/real-world-benchmark-matrix.ts",
      "--",
      "--matrix",
      "benchmarks/real-world/matrix.json",
      "--config",
      "benchmarks/real-world/benchmark.config.json",
      "--out-dir",
      outDir,
      "--limit-runs",
      "1",
      "--skip-index",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    assert.doesNotMatch(output, /ERR_INVALID_TYPESCRIPT_SYNTAX/);
    assert.doesNotMatch(output, /Expected ',', got ';'/);
    assert.doesNotMatch(output, /ReferenceError: ignore is not defined/);
  });
});


it("matrix preserves a failed repository and continues independent repositories", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sdl-matrix-failure-"));
  mkdirSync(resolve(dir, "scripts"));
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(resolve(dir, "tasks.json"), "{}");
  const runs = [
    { id: "a-first", repoId: "a" },
    { id: "a-dependent", repoId: "a" },
    { id: "b-first", repoId: "b" },
    { id: "b-reuse", repoId: "b" },
    { id: "a-last", repoId: "a" },
  ].map((run) => ({ ...run, family: "test", tasks: "tasks.json" }));
  writeFileSync(resolve(dir, "matrix.json"), JSON.stringify({ version: 1, runs }));
  // Replace only the expensive child benchmark boundary; exercise the real matrix.
  writeFileSync(resolve(dir, "scripts/real-world-benchmark.ts"), String.raw`
    import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const args = process.argv.slice(2);
    const value = name => args[args.indexOf('--' + name) + 1];
    const repoId = value('repo-id');
    appendFileSync('attempts.jsonl', JSON.stringify({repoId, skipIndex: args.includes('--skip-index'), database: process.env.SDL_GRAPH_DB_PATH}) + '\n');
    if (repoId === 'a') {
      mkdirSync(dirname(process.env.SDL_GRAPH_DB_PATH), {recursive:true});
      writeFileSync(process.env.SDL_GRAPH_DB_PATH, 'failed-index-evidence');
      throw new Error('SEMANTIC_FINAL_ASSESSMENT_DEGRADED: controlled failure');
    }
    writeFileSync(value('out'), JSON.stringify({summary:{taskCount:1},tasks:[{comparison:{tokenReductionPct:1,contextCoverageGainPct:1,fileCoverageGainPct:1,symbolCoverageGainPct:1,precisionGainPct:1,recallGainPct:1}}]}));
  `);
  const outDir = resolve(dir, "output");
  const result = spawnSync(process.execPath, [
    resolve(repoRoot, "scripts/real-world-benchmark-matrix.ts"),
    "--matrix", resolve(dir, "matrix.json"), "--out-dir", outDir,
  ], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const attempts = readFileSync(resolve(dir, "attempts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(attempts.map((attempt) => attempt.repoId), ["a", "b", "b"]);
  assert.deepEqual(attempts.map((attempt) => attempt.skipIndex), [false, false, true]);
  assert.equal(attempts[1].database, attempts[2].database);
  assert.equal(readFileSync(attempts[0].database, "utf8"), "failed-index-evidence");
  assert.match(result.stderr, /a-dependent.*BLOCKED/);
  assert.match(result.stderr, /a-last.*BLOCKED/);
  const aggregate = JSON.parse(readFileSync(resolve(outDir, "aggregate.json"), "utf8"));
  assert.equal(aggregate.runCount, 2);
  assert.equal(aggregate.taskCount, 2);
  assert.match(result.stderr, /3 run\(s\) failed: a-first, a-dependent, a-last/);
});


it("activates the explicit benchmark config for nested index and retrieval reads", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "sdl-benchmark-config-routing-"));
  const inherited = resolve(dir, "inherited.json");
  const explicit = resolve(dir, "explicit.json");
  writeFileSync(inherited, JSON.stringify({ repos: [], policy: {}, semantic: { enabled: true, provider: "mock" } }));
  writeFileSync(explicit, JSON.stringify({ repos: [], policy: {}, semantic: { enabled: true, provider: "local" } }));
  const source = readFileSync(resolve(repoRoot, "scripts/real-world-benchmark.ts"), "utf8");
  const boundary = source.split("const defaults = applyBenchmarkModeDefaults(normalized.defaults, mode);")[1].split("const graphDbPath =")[0];
  const prepare = new Function("configPath", "loadConfig", "activateCliConfigPath", "resolve", "process", boundary + "return config;");
  const previous = process.env.SDL_CONFIG;
  try {
    process.env.SDL_CONFIG = inherited;
    invalidateConfigCache();
    const selected = prepare(explicit, loadConfig, activateCliConfigPath, resolve, process);
    assert.equal(selected.semantic.provider, "local");
    assert.equal(loadConfig().semantic.provider, "local", "nested no-argument reads must use the explicit benchmark configuration");
    assert.equal(process.env.SDL_CONFIG, explicit);
  } finally {
    if (previous === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previous;
    invalidateConfigCache();
  }
});
