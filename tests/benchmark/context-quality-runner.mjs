import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const windowsRuntimePath = resolve(
  repoRoot,
  "dist/db/ladybug-windows-fts-runtime.js",
);
const { isWindowsFtsRuntimeUnavailable, withWindowsFtsRuntime } = await import(
  pathToFileURL(windowsRuntimePath).href
);
const { runBenchmarkChild } = await import(
  pathToFileURL(resolve(repoRoot, "dist/benchmark/external-runner.js")).href
);

const CHILD_TIMEOUT_MS = (() => {
  const raw = process.env.SDL_CONTEXT_QUALITY_CHILD_TIMEOUT_MS;
  if (raw === undefined) return 30 * 60_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "SDL_CONTEXT_QUALITY_CHILD_TIMEOUT_MS must be a positive integer",
    );
  }
  return value;
})();
const READ_CHECKOUT_SHA_SCRIPT = String.raw`
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const checkoutRoot = process.argv[1];
const { stdout } = await promisify(execFile)(
  "git",
  ["-C", checkoutRoot, "rev-parse", "HEAD"],
  { encoding: "utf8", windowsHide: true },
);
process.stdout.write(stdout);
`;
let childSequence = 0;

function requiredEnvironmentPath(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for graph cache preparation`);
  return resolve(value);
}

function sameFingerprint(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runWatchedCommand(
  command,
  childEnvironment,
  artifactStem,
  emitSuccessfulLogs = true,
) {
  childSequence += 1;
  const childLogDir = resolve(dirname(artifactStem), "context-quality-child-logs");
  mkdirSync(childLogDir, { recursive: true });
  const logStem = resolve(childLogDir, `${process.pid}-${childSequence}`);
  const stdoutPath = `${logStem}.stdout.log`;
  const stderrPath = `${logStem}.stderr.log`;
  let logsEmitted = false;
  const emitLogs = () => {
    if (logsEmitted) return;
    logsEmitted = true;
    for (const [path, stream] of [
      [stdoutPath, process.stdout],
      [stderrPath, process.stderr],
    ]) {
      try {
        stream.write(readFileSync(path, "utf8"));
      } catch {
        // The child can fail before a log stream is available.
      }
    }
  };
  try {
    const result = await runBenchmarkChild({
      command,
      cwd: repoRoot,
      env: childEnvironment,
      stdoutPath,
      stderrPath,
      rawResultPath: `${logStem}.raw.json`,
      timeoutMs: CHILD_TIMEOUT_MS,
    });
    if (emitSuccessfulLogs) emitLogs();
    if (result.exitCode !== 0) {
      throw new Error(
        `context-quality child exited with code ${String(result.exitCode)}`,
      );
    }
    return { ...result, stdoutPath, stderrPath };
  } catch (error) {
    emitLogs();
    throw error;
  }
}

async function runWatchedChild(
  args,
  childEnvironment,
  artifactStem,
  emitSuccessfulLogs = true,
) {
  return runWatchedCommand(
    [process.execPath, ...args],
    childEnvironment,
    artifactStem,
    emitSuccessfulLogs,
  );
}

async function readCheckoutSha(checkoutRoot, artifactStem) {
  const { stdoutPath } = await runWatchedChild(
    ["--input-type=module", "--eval", READ_CHECKOUT_SHA_SCRIPT, checkoutRoot],
    process.env,
    artifactStem,
    false,
  );
  return readFileSync(stdoutPath, "utf8").trim();
}

async function runCanonicalProbe(workingPrimaryPath, outputPath) {
  const pendingOutputPath = `${outputPath}.pending-${process.pid}`;
  const pendingArtifactPath = `${outputPath}.artifact.json.pending-${process.pid}`;
  rmSync(pendingOutputPath, { force: true });
  rmSync(pendingArtifactPath, { force: true });
  const childEnvironment = {
    ...process.env,
    SDL_CONTEXT_QUALITY_RUNNER_CHILD: "1",
    SDL_CONTEXT_QUALITY_SKIP_CACHE_RESTORE: "1",
    SDL_CONTEXT_QUALITY_CANONICAL_V2_PROBE_OUTPUT: pendingOutputPath,
    SDL_CONTEXT_QUALITY_CASE_ID: process.env.SDL_CONTEXT_QUALITY_CORPUS === "neutral"
      ? "neutral-explain-cart-totals"
      : "qa-2026-07-26-server-instructions-broad",
    SDL_CONTEXT_QUALITY_VARIANT: "semantic",
    SDL_CONTEXT_QUALITY_V2_SHADOW: "1",
    SDL_CONTEXT_QUALITY_WORKING_DB_PATH: workingPrimaryPath,
    SDL_CONTEXT_QUALITY_OUTPUT_PATH: pendingArtifactPath,
    SDL_GRAPH_DB_PATH: workingPrimaryPath,
  };
  delete childEnvironment.SDL_CONTEXT_QUALITY_CACHE_PREPARE_ONLY;
  delete childEnvironment.SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH;
  delete childEnvironment.SDL_CONTEXT_QUALITY_EXIT_PATH;
  try {
    await runWatchedChild(
      [fileURLToPath(import.meta.url)],
      childEnvironment,
      pendingOutputPath,
    );
    renameSync(pendingOutputPath, outputPath);
  } catch (error) {
    rmSync(pendingOutputPath, { force: true });
    throw error;
  } finally {
    rmSync(pendingArtifactPath, { force: true });
  }
}

async function runCanonicalV2DeterminismGate({
  cachedPrimaryPath,
  readyMarkerPath,
  workingPrimaryPath,
  sourcePrimaryPath,
  validateCopiedFamily,
  copyDbFamilyForValidatedClone,
  restoreVerifiedDbFamilyCache,
  fingerprintDbFamily,
}) {
  if (
    process.env.SDL_CONTEXT_QUALITY_V2_SHADOW !== "1" ||
    process.env.SDL_CONTEXT_QUALITY_SKIP_CACHE_RESTORE === "1"
  ) {
    return;
  }

  // Database-prefixed siblings belong to the guarded database family. Keep
  // the canonical clone and its probe artifacts outside the working family.
  const determinismDir = resolve(
    dirname(workingPrimaryPath),
    "context-quality-canonical",
    `${basename(workingPrimaryPath)}-${process.pid}`,
  );
  mkdirSync(determinismDir, { recursive: true });
  const determinismPrimaryPath = resolve(determinismDir, "graph.lbug");
  const beforeOutput = resolve(determinismDir, "before.json");
  const freshOutput = resolve(determinismDir, "fresh.json");
  const afterOutput = resolve(determinismDir, "after.json");
  const cacheBefore = fingerprintDbFamily(cachedPrimaryPath);
  const resolvedSourcePath = sourcePrimaryPath
    ? resolve(sourcePrimaryPath)
    : undefined;
  const sourceBefore = resolvedSourcePath
    ? fingerprintDbFamily(resolvedSourcePath)
    : undefined;

  await restoreVerifiedDbFamilyCache({
    cachedPrimaryPath,
    readyMarkerPath,
    workingPrimaryPath: determinismPrimaryPath,
    validateCopiedFamily,
  });

  // Each probe child owns the working family and calls closeLadybugDb on exit.
  await runCanonicalProbe(determinismPrimaryPath, beforeOutput);
  await runCanonicalProbe(determinismPrimaryPath, freshOutput);
  const beforeBytes = readFileSync(beforeOutput, "utf8");
  const freshBytes = readFileSync(freshOutput, "utf8");
  if (freshBytes !== beforeBytes) {
    throw new Error(
      "Canonical V2 payload bytes changed across fresh processes",
    );
  }

  const reindexEnvironment = {
    ...process.env,
    SDL_GRAPH_DB_PATH: determinismPrimaryPath,
  };
  delete reindexEnvironment.SDL_GRAPH_DB_DIR;
  delete reindexEnvironment.SDL_DB_PATH;
  await runWatchedChild(
    [resolve(repoRoot, "dist/cli/index.js"), "index"],
    reindexEnvironment,
    `${determinismPrimaryPath}.reindex`,
  ); // supported no-op re-index; SDL_GRAPH_DB_PATH is the sole DB target

  // Validation requires a newly issued, single-use copy capability. The
  // original clone's capability was consumed before the first probe.
  const reindexedPrimaryPath = resolve(determinismDir, "reindexed.lbug");
  const reindexedCopy = copyDbFamilyForValidatedClone(
    determinismPrimaryPath,
    reindexedPrimaryPath,
  );
  await validateCopiedFamily(reindexedPrimaryPath, reindexedCopy);
  await runCanonicalProbe(reindexedPrimaryPath, afterOutput);

  const afterBytes = readFileSync(afterOutput, "utf8");
  if (afterBytes !== beforeBytes) {
    throw new Error(
      "Canonical V2 payload bytes changed after a verified no-op re-index",
    );
  }
  if (!sameFingerprint(cacheBefore, fingerprintDbFamily(cachedPrimaryPath))) {
    throw new Error("Canonical V2 gate mutated the immutable cache family");
  }
  if (
    resolvedSourcePath &&
    sourceBefore &&
    !sameFingerprint(sourceBefore, fingerprintDbFamily(resolvedSourcePath))
  ) {
    throw new Error("Canonical V2 gate mutated the source graph family");
  }
}

async function prepareVerifiedGraphCache() {
  if (process.env.SDL_CONTEXT_QUALITY_SKIP_CACHE_RESTORE === "1") {
    const workingPrimaryPath = requiredEnvironmentPath(
      "SDL_CONTEXT_QUALITY_WORKING_DB_PATH",
    );
    delete process.env.SDL_GRAPH_DB_DIR;
    delete process.env.SDL_DB_PATH;
    process.env.SDL_GRAPH_DB_PATH = workingPrimaryPath;
    return;
  }
  if (!process.env.SDL_CONTEXT_QUALITY_CACHE_PRIMARY_PATH) return;

  const configPath = requiredEnvironmentPath("SDL_CONFIG");
  const cachedPrimaryPath = requiredEnvironmentPath(
    "SDL_CONTEXT_QUALITY_CACHE_PRIMARY_PATH",
  );
  const readyMarkerPath = requiredEnvironmentPath(
    "SDL_CONTEXT_QUALITY_CACHE_READY_PATH",
  );
  const workingPrimaryPath = requiredEnvironmentPath(
    "SDL_CONTEXT_QUALITY_WORKING_DB_PATH",
  );
  const repoId = process.env.SDL_CONTEXT_QUALITY_REPO_ID ?? "sdl-mcp";
  const repoSha = process.env.SDL_CONTEXT_QUALITY_REPO_SHA;
  if (!repoSha || !/^[0-9a-f]{40}$/u.test(repoSha)) {
    throw new Error("SDL_CONTEXT_QUALITY_REPO_SHA must be a pinned SHA-1");
  }

  const [
    { loadConfig },
    { resolveSemanticEmbeddingModelPlan },
    { LADYBUG_SCHEMA_VERSION },
    { validateContextQualityCacheFamily },
    {
      copyDbFamilyForValidatedClone,
      fingerprintDbFamily,
      publishVerifiedDbFamilyCache,
      restoreVerifiedDbFamilyCache,
    },
  ] = await Promise.all([
    import("../../dist/config/loadConfig.js"),
    import("../../dist/config/semantic-embedding-model-plan.js"),
    import("../../dist/db/ladybug-schema.js"),
    import("../../dist/benchmark/context-quality-cache.js"),
    import("../../dist/benchmark/external-runner.js"),
  ]);
  const config = loadConfig(configPath);
  if (config.repos.length !== 1 || config.repos[0]?.repoId !== repoId) {
    throw new Error(
      "Context-quality cache config must contain exactly the selected repo",
    );
  }
  const repoConfig = config.repos[0];
  mkdirSync(dirname(workingPrimaryPath), { recursive: true });
  const checkoutSha = await readCheckoutSha(
    repoConfig.rootPath,
    resolve(
      dirname(workingPrimaryPath),
      `checkout-${basename(workingPrimaryPath)}`,
    ),
  );
  if (checkoutSha !== repoSha) {
    throw new Error(
      `Pinned context-quality checkout mismatch: expected ${repoSha}, received ${checkoutSha}`,
    );
  }

  const manifestConfigPath = resolve(
    process.env.SDL_CONTEXT_QUALITY_MANIFEST_CONFIG_PATH ?? configPath,
  );
  const configDigest = createHash("sha256")
    .update(readFileSync(manifestConfigPath))
    .digest("hex");
  const modelPlan = resolveSemanticEmbeddingModelPlan(config.semantic);
  if (modelPlan.unsupportedModels.length > 0) {
    throw new Error(
      "Unsupported context-quality model(s): " +
        modelPlan.unsupportedModels.join(", "),
    );
  }
  const expectation = {
    repoId,
    repoRoot: repoConfig.rootPath,
    repoSha,
    configDigest,
    ladybugSchemaVersion: LADYBUG_SCHEMA_VERSION,
    symbolEmbeddingModels: modelPlan.symbolEmbeddingModels,
    fileSummaryEmbeddingModels: modelPlan.fileSummaryEmbeddingModels,
  };
  const validateCopiedFamily = (primaryPath, verifiedCopyFingerprint) =>
    validateContextQualityCacheFamily(primaryPath, {
      expectation,
      semanticConfig: config.semantic,
      verifiedCopyFingerprint,
      bufferPoolBytes: config.graphDatabase?.bufferPoolBytes,
    });

  const preparation = await withWindowsFtsRuntime(async () => {
    const sourcePrimaryPath = process.env.SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH;
    if (sourcePrimaryPath) {
      await publishVerifiedDbFamilyCache({
        sourcePrimaryPath: resolve(sourcePrimaryPath),
        destinationPrimaryPath: cachedPrimaryPath,
        readyMarkerPath,
        validateCopiedFamily,
      });
    }
    await restoreVerifiedDbFamilyCache({
      cachedPrimaryPath,
      readyMarkerPath,
      workingPrimaryPath,
      validateCopiedFamily,
    });
    await runCanonicalV2DeterminismGate({
      cachedPrimaryPath,
      readyMarkerPath,
      workingPrimaryPath,
      sourcePrimaryPath,
      validateCopiedFamily,
      copyDbFamilyForValidatedClone,
      restoreVerifiedDbFamilyCache,
      fingerprintDbFamily,
    });
  });
  if (isWindowsFtsRuntimeUnavailable(preparation)) {
    throw new Error(
      `Windows FTS runtime is unavailable: ${preparation.reason}`,
    );
  }

  // The benchmark opens only the independently validated working copy.
  delete process.env.SDL_GRAPH_DB_DIR;
  delete process.env.SDL_DB_PATH;
  process.env.SDL_GRAPH_DB_PATH = workingPrimaryPath;
}

function assertRequestedV2Artifact() {
  if (process.env.SDL_CONTEXT_QUALITY_V2_SHADOW !== "1") return;
  const artifactPath = requiredEnvironmentPath(
    "SDL_CONTEXT_QUALITY_OUTPUT_PATH",
  );
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(
      "V2 shadow was requested but the artifact is missing or invalid",
      { cause: error },
    );
  }
  if (artifact.v2Shadow === null || artifact.v2Shadow === undefined) {
    throw new Error(
      "V2 shadow was requested but the artifact is missing v2Shadow metrics",
    );
  }
}

async function runContextQualityTests() {
  let failed = false;
  const tests = run({
    files: [resolve(repoRoot, "tests/benchmark/context-quality.test.ts")],
    cwd: repoRoot,
    isolation: "none",
    concurrency: false,
  });
  tests.on("test:fail", () => {
    failed = true;
  });

  const reporter = spec();
  tests.pipe(reporter).pipe(process.stdout, { end: false });
  await finished(reporter);
  if (!failed) assertRequestedV2Artifact();
  return failed ? 1 : 0;
}

async function runPreparedBenchmarkChild() {
  const finalArtifactPath = resolve(
    process.env.SDL_CONTEXT_QUALITY_OUTPUT_PATH ??
      ".benchmark/context-quality-results.json",
  );
  const pendingArtifactPath = `${finalArtifactPath}.pending-${process.pid}`;
  mkdirSync(dirname(finalArtifactPath), { recursive: true });
  rmSync(finalArtifactPath, { force: true });
  rmSync(pendingArtifactPath, { force: true });

  const childEnvironment = {
    ...process.env,
    SDL_CONTEXT_QUALITY_RUNNER_CHILD: "1",
    SDL_CONTEXT_QUALITY_SKIP_CACHE_RESTORE: "1",
    SDL_CONTEXT_QUALITY_OUTPUT_PATH: pendingArtifactPath,
  };
  delete childEnvironment.SDL_CONTEXT_QUALITY_CACHE_PREPARE_ONLY;
  delete childEnvironment.SDL_CONTEXT_QUALITY_CACHE_SOURCE_PATH;
  delete childEnvironment.SDL_CONTEXT_QUALITY_CANONICAL_V2_PROBE_OUTPUT;
  delete childEnvironment.SDL_CONTEXT_QUALITY_EXIT_PATH;

  try {
    await runWatchedChild(
      [fileURLToPath(import.meta.url)],
      childEnvironment,
      pendingArtifactPath,
    );
    renameSync(pendingArtifactPath, finalArtifactPath);
  } catch (error) {
    rmSync(pendingArtifactPath, { force: true });
    throw error;
  }
  return 0;
}

async function runOuterContextQuality() {
  // Cache preparation finishes and closes its DB before any benchmark child starts.
  await prepareVerifiedGraphCache();
  if (process.env.SDL_CONTEXT_QUALITY_CACHE_PREPARE_ONLY === "1") return 0;
  return runPreparedBenchmarkChild();
}

const exitCode =
  process.env.SDL_CONTEXT_QUALITY_RUNNER_CHILD === "1"
    ? await (async () => {
        // Keep Win32 FTS DLL handles alive until the child has closed LadybugDB.
        const result = await withWindowsFtsRuntime(runContextQualityTests);
        if (isWindowsFtsRuntimeUnavailable(result)) {
          throw new Error(
            `Windows FTS runtime is unavailable: ${result.reason}`,
          );
        }
        return result;
      })()
    : await runOuterContextQuality();

if (process.env.SDL_CONTEXT_QUALITY_EXIT_PATH) {
  writeFileSync(
    process.env.SDL_CONTEXT_QUALITY_EXIT_PATH,
    `${exitCode}\n`,
    "utf8",
  );
}
process.exitCode = exitCode;
