import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { collectLadybugFamilyFiles } from "../../dist/db/ladybug-family-files.js";

const repoRoot = resolve(import.meta.dirname, "../..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("scheduled context-quality graph cache", () => {
  it("keeps real-model contract checks in mandatory scheduled jobs, outside the native-disabled runner", () => {
    const runner = readSource("scripts/run-tests.mjs");
    const discovery = runner.slice(
      runner.indexOf("const SKIP_PATTERNS ="),
      runner.indexOf("if (testFiles.length === 0)"),
    );
    const paths = [
      "tests/benchmark/info-contract.test.ts",
      "tests/benchmark/context-quality.test.ts",
      "tests/benchmark/background-graph-integrity.test.ts",
    ];
    const selected = new Function("allTestFiles", "selectedGroups", "testGroupFor",
      discovery + "return testFiles;",
    )(paths, new Set(), () => "benchmark");
    assert.deepEqual(selected, [paths[2]]);
    const workflow = readSource(".github/workflows/ci.yml");
    assert.match(workflow, /- name: Verify versioned sdl\.info retrieval contract\r?\n        run: node --experimental-strip-types --test tests\/benchmark\/info-contract\.test\.ts/);
  });

  it("keeps canonical probe artifacts outside both database families", async () => {
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");
    const gate = runner.slice(
      runner.indexOf("async function runCanonicalV2DeterminismGate("),
      runner.indexOf("async function prepareVerifiedGraphCache("),
    );
    const dir = mkdtempSync(join(tmpdir(), "sdl-canonical-family-"));
    const workingPrimaryPath = join(dir, "working.lbug");
    const probes: string[] = [];
    try {
      writeFileSync(workingPrimaryPath, "working");
      const runGate = new Function(
        "process", "resolve", "dirname", "basename", "mkdirSync", "readFileSync",
        "repoRoot", "runCanonicalProbe", "runWatchedChild", "sameFingerprint",
        gate + "return runCanonicalV2DeterminismGate;",
      )(
        { env: { SDL_CONTEXT_QUALITY_V2_SHADOW: "1" }, pid: process.pid },
        resolve, dirname, basename, mkdirSync, readFileSync, repoRoot,
        async (primary: string, output: string) => {
          const pending = `${output}.pending-${process.pid}`;
          writeFileSync(pending, "canonical");
          assert.deepEqual(collectLadybugFamilyFiles(primary), [primary]);
          assert.deepEqual(collectLadybugFamilyFiles(workingPrimaryPath), [workingPrimaryPath]);
          writeFileSync(output, "canonical");
          probes.push(output);
        },
        async () => {},
        (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
      );
      await runGate({
        cachedPrimaryPath: join(dir, "cache.lbug"),
        readyMarkerPath: join(dir, "ready.json"),
        workingPrimaryPath,
        validateCopiedFamily: async () => {},
        restoreVerifiedDbFamilyCache: async ({ workingPrimaryPath: primary }: { workingPrimaryPath: string }) => {
          mkdirSync(dirname(primary), { recursive: true });
          writeFileSync(primary, "canonical graph");
        },
        fingerprintDbFamily: () => [],
      });
      assert.equal(probes.length, 3, "all determinism comparisons must still run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses one-repo immutable configs for both benchmark corpora", () => {
    for (const [path, repoId] of [
      ["tests/benchmark/config/context-quality-sdl-mcp.json", "sdl-mcp"],
      [
        "tests/benchmark/config/context-quality-neutral.json",
        "sdl-neutral-fixture",
      ],
    ] as const) {
      const config = JSON.parse(readSource(path)) as {
        repos: Array<{ repoId: string; rootPath: string }>;
        indexing: {
          pipeline: string;
          engine: string;
          enableFileWatching: boolean;
        };
        scip: { enabled: boolean };
        semantic: {
          provider: string;
          symbolEmbeddingModels: string[];
          fileSummaryEmbeddingModels: string[];
        };
      };
      assert.equal(config.repos.length, 1, path);
      assert.deepEqual(config.repos[0], {
        ...config.repos[0],
        repoId,
        rootPath: "${SDL_CONTEXT_QUALITY_REPO_ROOT}",
      });
      assert.deepEqual(config.indexing, {
        ...config.indexing,
        pipeline: "legacy",
        engine: "typescript",
        enableFileWatching: false,
      });
      assert.equal(config.scip.enabled, false);
      assert.equal(config.semantic.provider, "local");
      assert.deepEqual(config.semantic.symbolEmbeddingModels, [
        "jina-embeddings-v2-base-code",
      ]);
      assert.deepEqual(config.semantic.fileSummaryEmbeddingModels, [
        "nomic-embed-text-v1.5",
      ]);
    }
  });

  it("publishes on misses and restores every benchmark from a copied family", () => {
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");
    assert.match(
      runner,
      /SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH[\s\S]*publishVerifiedDbFamilyCache/,
    );
    assert.match(
      runner,
      /restoreVerifiedDbFamilyCache[\s\S]*SDL_GRAPH_DB_PATH = workingPrimaryPath/,
    );
    assert.match(
      runner,
      /config\.repos\.length !== 1[\s\S]*checkoutSha !== repoSha/,
    );
    assert.match(runner, /SDL_CONTEXT_QUALITY_CACHE_PREPARE_ONLY === "1"/);
  });

  it("checks the pinned checkout through the watched lifecycle before opening a database", () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-context-cache-preflight-"));
    const configPath = join(root, "config.json");
    const cachePrimaryPath = join(root, "cache", "graph.lbug");
    const readyMarkerPath = join(root, "cache", "ready.json");
    const workingPrimaryPath = join(root, "working", "graph.lbug");
    const config = JSON.parse(
      readSource("tests/benchmark/config/context-quality-sdl-mcp.json"),
    ) as {
      repos: Array<{ rootPath: string }>;
      graphDatabase: { path: string };
    };
    config.repos[0]!.rootPath = repoRoot;
    config.graphDatabase.path = join(root, "unused.lbug");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const environment = {
      ...process.env,
      SDL_CONFIG: configPath,
      SDL_CONTEXT_QUALITY_CACHE_PRIMARY_PATH: cachePrimaryPath,
      SDL_CONTEXT_QUALITY_CACHE_READY_PATH: readyMarkerPath,
      SDL_CONTEXT_QUALITY_WORKING_DB_PATH: workingPrimaryPath,
      SDL_CONTEXT_QUALITY_REPO_ID: "sdl-mcp",
      SDL_CONTEXT_QUALITY_REPO_SHA: "0".repeat(40),
      SDL_CONTEXT_QUALITY_CACHE_PREPARE_ONLY: "1",
      SDL_CONTEXT_QUALITY_CHILD_TIMEOUT_MS: "5000",
    };
    for (const name of [
      "SDL_GRAPH_DB_DIR",
      "SDL_DB_PATH",
      "SDL_GRAPH_DB_PATH",
      "SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH",
      "SDL_CONTEXT_QUALITY_RUNNER_CHILD",
      "SDL_CONTEXT_QUALITY_SKIP_CACHE_RESTORE",
    ]) {
      delete environment[name];
    }

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "tests/benchmark/context-quality-runner.mjs",
        ],
        {
          cwd: repoRoot,
          env: environment,
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /Pinned context-quality checkout mismatch: expected 0{40}, received [0-9a-f]{40}/u,
      );
      assert.doesNotMatch(result.stderr, /execFileSync is not defined/u);
      assert.equal(existsSync(cachePrimaryPath), false);
      assert.equal(existsSync(readyMarkerPath), false);
      assert.equal(existsSync(workingPrimaryPath), false);
      const primaryName = basename(workingPrimaryPath);
      const workingEntries = readdirSync(dirname(workingPrimaryPath)).sort();
      assert.deepEqual(
        workingEntries.filter(
          (name) =>
            name === primaryName || name.startsWith(`${primaryName}.`),
        ),
        [],
      );
      const childLogs = readdirSync(
        resolve(dirname(workingPrimaryPath), "context-quality-child-logs"),
      );
      assert.equal(childLogs.length, 2);
      assert.ok(childLogs.some((name) => name.endsWith(".stdout.log")));
      assert.ok(childLogs.some((name) => name.endsWith(".stderr.log")));

      const runner = readSource("tests/benchmark/context-quality-runner.mjs");
      assert.match(
        runner,
        /const READ_CHECKOUT_SHA_SCRIPT = String\.raw`[\s\S]*promisify\(execFile\)[\s\S]*"git",\s*\[\s*"-C",\s*checkoutRoot,\s*"rev-parse",\s*"HEAD",?\s*\]/u,
      );
      assert.match(
        runner,
        /runWatchedChild\(\s*\[\s*"--input-type=module",\s*"--eval",\s*READ_CHECKOUT_SHA_SCRIPT,\s*checkoutRoot,?\s*\],[\s\S]*?artifactStem,\s*false,\s*\)/u,
      );
      assert.match(
        runner,
        /runBenchmarkChild\(\{\s*command,\s*cwd:\s*repoRoot,\s*env:\s*childEnvironment,\s*stdoutPath,\s*stderrPath,\s*rawResultPath:[\s\S]*?timeoutMs:\s*CHILD_TIMEOUT_MS/u,
      );
      assert.doesNotMatch(runner, /execFileSync/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires strict LadybugDB close before cache validation succeeds", () => {
    const cacheValidator = readSource("src/benchmark/context-quality-cache.ts");
    assert.match(
      cacheValidator,
      /closeLadybugDb\(\{\s*preserveCloseHooks:\s*true,\s*strict:\s*true,\s*\}\)/,
    );
  });

  it("keeps the OS matrix scheduled-only and keys every immutable input", () => {
    const workflow = readSource(".github/workflows/ci.yml");
    const job =
      workflow.match(/context-quality-scheduled:\s*[\s\S]*$/u)?.[0] ?? "";
    assert.ok(job, "context-quality-scheduled job must be present");
    assert.match(workflow, /verification_scope:[\s\S]*?default: full/);
    const matrixJob = workflow.split("  benchmark-matrix-nightly:")[1];
    for (const semanticJob of [job, matrixJob]) {
      const condition = semanticJob.match(/if:\s*(.*)/)?.[1];
      assert.ok(condition);
      const enabled = new Function("github", "inputs", `return ${condition};`);
      for (const scope of [undefined, "full", "fast"]) {
        assert.equal(enabled({ event_name: "schedule" }, { verification_scope: scope }), true);
        assert.equal(enabled({ event_name: "workflow_dispatch" }, { verification_scope: scope }), scope !== "fast");
        assert.equal(enabled({ event_name: "push" }, { verification_scope: scope }), false);
        assert.equal(enabled({ event_name: "pull_request" }, { verification_scope: scope }), false);
      }
    }
    assert.match(job, /os:\s*\n\s*- ubuntu-latest\s*\n\s*- windows-latest/);
    assert.match(
      job,
      /node scripts\/postinstall-models\.mjs --strict[\s\S]*Cache verified context-quality graph families/,
    );
    assert.match(
      job,
      /key:\s*\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-schema\$\{\{ steps\.context-inputs\.outputs\.schema \}\}-models-\$\{\{ steps\.context-inputs\.outputs\.model-set \}\}-corpus-fcf4f2e11c5a1bb9b301a245af42b28556414b8e-configs-\$\{\{ hashFiles\(/,
    );
    assert.equal(
      [...job.matchAll(/index --force --safe-rebuild/g)].length,
      2,
      "a miss must safe-rebuild both one-repo corpora",
    );
    assert.match(
      job,
      /Publish both verified graph families on cache miss[\s\S]*if:\s*steps\.context-graph-cache\.outputs\.cache-hit != 'true'/,
    );
    assert.match(
      job,
      /Run paired context-quality evaluation from validated copies[\s\S]*Remove-Item Env:SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH/,
    );
  });

  it("runs both scheduled corpora with the V2 shadow gate enabled", () => {
    const workflow = readSource(".github/workflows/ci.yml");
    const job =
      workflow.match(/context-quality-scheduled:\s*[\s\S]*$/u)?.[0] ?? "";
    const pairedStep =
      job.match(
        /- name: Run paired context-quality evaluation from validated copies[\s\S]*?(?=\n\s+- name:|\s*$)/u,
      )?.[0] ?? "";

    assert.ok(pairedStep, "paired context-quality step must be present");
    assert.match(
      pairedStep,
      /env:\s*[\s\S]*SDL_CONTEXT_QUALITY_V2_SHADOW:\s*["']?1["']?/u,
    );
  });

  it("labels and enforces the exact 2026-07-26 V2 ranking floor", () => {
    const cases = JSON.parse(
      readSource("tests/benchmark/context-quality-cases.json"),
    ) as Array<{
      id: string;
      v2HardFloor?: {
        prioritySymbols: string[];
        unrelatedSymbols: string[];
        codeBearingSymbols: string[];
      };
    }>;
    const target = cases.find(
      (candidate) => candidate.id === "qa-2026-07-26-server-instructions-broad",
    );

    assert.deepEqual(target?.v2HardFloor, {
      prioritySymbols: ["SDL_MCP_SERVER_INSTRUCTIONS", "MCPServer"],
      unrelatedSymbols: ["Mode", "sdlMcp"],
      codeBearingSymbols: ["SDL_MCP_SERVER_INSTRUCTIONS", "MCPServer"],
    });

    const benchmark = readSource("tests/benchmark/context-quality.test.ts");
    assert.match(
      benchmark,
      /function assertV2ShadowQuality[\s\S]*v2HardFloor[\s\S]*prioritySymbols[\s\S]*unrelatedSymbols[\s\S]*codeBearingSymbols/u,
    );
  });

  it("gates canonical V2 bytes across every degradation and isolated re-index", () => {
    const benchmark = readSource("tests/benchmark/context-quality.test.ts");
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");

    assert.match(benchmark, /assertCanonicalV2PayloadDeterminism/u);
    for (const level of [
      "hybrid",
      "hybrid-partial",
      "lexical",
      "graph-only",
      "insufficient",
    ]) {
      assert.match(benchmark, new RegExp(`"${level}"`, "u"));
    }
    assert.match(
      benchmark,
      /satisfies readonly ContextPayload\["retrieval"\]\["level"\]\[\]/u,
    );
    assert.match(benchmark, /function serializeControlledV2DegradationResults/u);
    assert.match(benchmark, /new ContextEngineV2\(/u);
    assert.match(benchmark, /buildRetrievalState\(/u);
    assert.match(
      benchmark,
      /assert\.equal\(retrieval\.level, scenario\.level\)/u,
    );
    assert.match(benchmark, /CONTEXT_RETRIEVAL_BACKEND_FAILED/u);
    assert.doesNotMatch(
      benchmark,
      /retrieval:\s*\{\s*\.\.\.first\.retrieval,\s*level\s*\}/u,
    );
    assert.doesNotMatch(
      benchmark,
      /Injected context-quality insufficient retrieval/u,
    );
    assert.doesNotMatch(benchmark, /const firstInsufficient/u);
    assert.doesNotMatch(benchmark, /as unknown as ContextPayload/u);
    assert.match(runner, /restoreVerifiedDbFamilyCache/u);
    assert.match(runner, /runCanonicalV2DeterminismGate/u);
    assert.match(
      runner,
      /resolve\(dirname\(artifactStem\), "context-quality-child-logs"\)/u,
    );
    assert.match(runner, /no-op re-index/u);
    assert.match(runner, /fingerprintDbFamily/u);
    assert.match(runner, /closeLadybugDb/u);
  });

  it("rejects missing V2 artifacts and surfaces every paired failure or timeout", () => {
    const benchmark = readSource("tests/benchmark/context-quality.test.ts");
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");

    assert.doesNotMatch(
      benchmark,
      /v2Shadow:\s*metrics\.v2Shadow\.cases\s*>\s*0\s*\?[\s\S]*?:\s*null/u,
    );
    assert.match(benchmark, /pairedLatency\.failures/u);
    assert.match(benchmark, /pairedLatency\.timeouts/u);
    assert.match(
      runner,
      /V2 shadow was requested but the artifact is missing/u,
    );
  });

  it("keeps paired latency in-process and assigns timeout ownership to the outer runner", () => {
    const benchmark = readSource("tests/benchmark/context-quality.test.ts");
    const pairedLatency =
      benchmark.match(
        /async function measurePairedLatency[\s\S]*?(?=\n(?:async )?function [A-Za-z])/u,
      )?.[0] ?? "";
    const externalRunner = readSource("src/benchmark/external-runner.ts");
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");

    assert.ok(pairedLatency, "measurePairedLatency must be present");
    assert.match(pairedLatency, /await engine\.buildContext/u);
    assert.doesNotMatch(
      pairedLatency,
      /Promise\.race|setTimeout|timeoutMs|paired context-quality timeout/u,
    );
    assert.match(externalRunner, /child-timeout/u);
    assert.match(externalRunner, /timeoutMs/u);
    assert.match(externalRunner, /killProcessTree/u);
    assert.match(runner, /runBenchmarkChild/u);
    assert.match(runner, /SDL_CONTEXT_QUALITY_CHILD_TIMEOUT_MS/u);
    assert.match(runner, /\.pending-/u);
  });

  it("targets the no-op re-index exclusively through validated environment", () => {
    const runner = readSource("tests/benchmark/context-quality-runner.mjs");

    assert.doesNotMatch(runner, /"index",\s*determinismPrimaryPath/u);
    assert.match(runner, /SDL_GRAPH_DB_PATH:\s*determinismPrimaryPath/u);
    assert.doesNotMatch(runner, /delete reindexEnvironment\.SDL_CONFIG/u);
  });

  it("uses the established cross-platform process-tree owner for child timeouts", () => {
    const executor = readSource("src/runtime/executor.ts");
    const externalRunner = readSource("src/benchmark/external-runner.ts");
    const contextQualityRunner = readSource(
      "tests/benchmark/context-quality-runner.mjs",
    );

    assert.match(
      executor,
      /execFileSync\("taskkill",\s*\["\/PID",\s*String\(pid\),\s*"\/T",\s*"\/F"\],[\s\S]*?windowsHide:\s*true/u,
    );
    assert.match(
      externalRunner,
      /import\s*\{\s*killProcessTree\s*\}\s*from\s*"\.\.\/runtime\/executor\.js"/u,
    );
    assert.match(externalRunner, /function isProcessAlive/u);
    assert.match(externalRunner, /async function waitForProcessDeath/u);
    assert.match(
      externalRunner,
      /detached:\s*lifecycle\.platform\s*!==\s*"win32"/u,
    );
    assert.match(
      externalRunner,
      /const processTarget\s*=\s*lifecycle\.platform\s*===\s*"win32"\s*\?\s*pid\s*:\s*-pid/u,
    );
    assert.match(
      externalRunner,
      /waitForProcessDeath\(\s*processTarget/u,
    );
    assert.match(
      externalRunner,
      /RUNTIME_SIGKILL_GRACE_MS\s*\+\s*PROCESS_DEATH_CONFIRMATION_MARGIN_MS/u,
    );
    assert.match(
      externalRunner,
      /const deadline\s*=\s*performance\.now\(\)\s*\+\s*timeoutMs/u,
    );
    assert.doesNotMatch(externalRunner, /let waitedMs/u);
    assert.doesNotMatch(contextQualityRunner, /killGraceMs/u);
    assert.doesNotMatch(
      externalRunner,
      /child\?\.kill\(boundary === "child-timeout"/u,
    );
  });
});
