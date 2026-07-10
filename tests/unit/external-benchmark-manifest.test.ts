import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildExternalBenchmarkResults,
  compareArtifactPath,
  fingerprintDirectory,
  fingerprintFiles,
  hashSerializedManifest,
  normalizeArtifactPath,
  serializeExternalBenchmarkResults,
  serializeRunManifest,
  sha256File,
  type ExternalBenchmarkMetricEvidence,
  type ExternalBenchmarkRawRepeat,
  type ExternalBenchmarkResults,
  type ExternalBenchmarkRunManifest,
  type HashedArtifactFile,
  type InitialDbFile,
} from "../../dist/benchmark/external-manifest.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);

function makeRepeat(
  repeat: number,
  initialDbFiles: InitialDbFile[] = [],
): ExternalBenchmarkRunManifest["repeats"][number] {
  const suffix = String(repeat).padStart(3, "0");
  return {
    repeat,
    graphDbPath: `db/repeat-${suffix}.lbug`,
    stdoutPath: `logs/repeat-${suffix}.stdout.log`,
    stderrPath: `logs/repeat-${suffix}.stderr.log`,
    initialDbFiles,
    command: [
      "node",
      "dist/cli/index.js",
      "benchmark:ci",
      "--repo-id",
      "scip-io",
      "--baseline-path",
      "inputs/baseline.json",
      "--threshold-path",
      "inputs/threshold.json",
      "--out-exclusive",
      "--out",
      `raw/repeat-${suffix}.benchmark.json`,
    ],
  };
}

function makeManifest(): ExternalBenchmarkRunManifest {
  return {
    schemaVersion: 1,
    target: {
      repoId: "scip-io",
      sourceRef: "locked-ref",
      sourceCommit: "1".repeat(40),
      sourceDirty: false,
      sourceTreeSha256: SHA_A,
      scipArtifactPath: "target/index.scip",
      scipArtifactSha256: SHA_B,
    },
    runner: {
      sdlMcpVersion: "0.12.2",
      sdlMcpCommit: "2".repeat(40),
      sdlMcpSourceDirty: false,
      sdlMcpBuildTreeSha256: SHA_C,
      launcherPath: "scripts/external-benchmark-runner.mjs",
      launcherSha256: SHA_D,
      nodeVersion: "v24.0.0",
      platform: "linux",
      architecture: "x64",
      cacheMode: "cold",
      repeats: 1,
    },
    inputs: {
      configPath: "inputs/sdlmcp.config.json",
      configSha256: SHA_E,
      baselinePath: "inputs/baseline.json",
      baselineSha256: SHA_F,
      baselineFormatVersion: "1",
      baselineTargetRepoId: "scip-io",
      thresholdSourcePath: "config/benchmark.config.json",
      thresholdPath: "inputs/threshold.json",
      thresholdSha256: SHA_A,
      warmSnapshot: null,
    },
    repeats: [makeRepeat(1)],
  };
}

function makeUnsortedWarmManifest(): ExternalBenchmarkRunManifest {
  const manifest = makeManifest();
  const initialDbFiles: InitialDbFile[] = [
    {
      sourcePath: "inputs/warm-db/repository.lbug.wal",
      destinationPath: "db/repeat-001.lbug.wal",
      sha256: SHA_B,
    },
    {
      sourcePath: "inputs/warm-db/repository.lbug",
      destinationPath: "db/repeat-001.lbug",
      sha256: SHA_A,
    },
  ];
  const warmFiles: HashedArtifactFile[] = [
    { path: "inputs/warm-db/repository.lbug.wal", sha256: SHA_B },
    { path: "inputs/warm-db/repository.lbug", sha256: SHA_A },
  ];

  return {
    ...manifest,
    runner: { ...manifest.runner, cacheMode: "warm", repeats: 2 },
    inputs: {
      ...manifest.inputs,
      warmSnapshot: { files: warmFiles },
    },
    repeats: [makeRepeat(2), makeRepeat(1, initialDbFiles)],
  };
}

describe("external benchmark canonical evidence", () => {
  it("serializes identical manifest inputs to identical bytes", () => {
    const first = serializeRunManifest(makeManifest());
    const second = serializeRunManifest(makeManifest());
    const parsed = JSON.parse(first) as Record<string, unknown>;

    assert.equal(first, second);
    assert.ok(first.endsWith("\n"));
    assert.deepStrictEqual(Object.keys(parsed), [
      "schemaVersion",
      "target",
      "runner",
      "inputs",
      "repeats",
    ]);
    assert.doesNotMatch(first, /[A-Za-z]:[\\/]|\\\\[^\\]/);
  });

  it("serializes canonical fixed paths and normalized safe artifact paths", () => {
    const manifest = makeManifest();
    manifest.target.scipArtifactPath = "target\\index.scip";
    manifest.repeats[0] = {
      ...manifest.repeats[0]!,
      graphDbPath: "db\\repeat-001.lbug",
    };
    const parsed = JSON.parse(serializeRunManifest(manifest));

    assert.equal(parsed.target.scipArtifactPath, "target/index.scip");
    assert.equal(
      parsed.runner.launcherPath,
      "scripts/external-benchmark-runner.mjs",
    );
    assert.equal(parsed.inputs.configPath, "inputs/sdlmcp.config.json");
    assert.equal(parsed.inputs.baselinePath, "inputs/baseline.json");
    assert.equal(
      parsed.inputs.thresholdSourcePath,
      "config/benchmark.config.json",
    );
    assert.equal(parsed.inputs.thresholdPath, "inputs/threshold.json");
    assert.equal(parsed.repeats[0].graphDbPath, "db/repeat-001.lbug");
    assert.equal(normalizeArtifactPath("logs\\repeat-001.stdout.log"), "logs/repeat-001.stdout.log");
    assert.equal(compareArtifactPath("Z", "a"), -1);
  });

  it("serializes only safe paths and lowercase SHA-256 hashes", () => {
    for (const unsafePath of [
      "",
      ".",
      "a/./b",
      "a/../b",
      "/tmp/file",
      "C:\\temp\\file",
      "\\\\server\\share\\file",
    ]) {
      assert.throws(() => normalizeArtifactPath(unsafePath), /path/i);
    }

    const invalidHash = makeManifest();
    invalidHash.inputs.configSha256 = "A".repeat(64);
    assert.throws(() => serializeRunManifest(invalidHash), /sha-256/i);
  });

  it("rejects Windows drive-relative paths during normalization", () => {
    for (const driveRelativePath of ["C:foo", "C:", "a/C:foo", "a/C:"]) {
      assert.throws(
        () => normalizeArtifactPath(driveRelativePath),
        /safe relative path/i,
      );
    }
    assert.equal(
      normalizeArtifactPath("segment:with-colon/file"),
      "segment:with-colon/file",
    );
  });

  it("rejects Windows drive-relative paths during manifest serialization", () => {
    for (const driveRelativePath of ["C:foo", "C:", "a/C:foo", "a/C:"]) {
      const manifest = makeManifest();
      manifest.target.scipArtifactPath = driveRelativePath;
      assert.throws(
        () => serializeRunManifest(manifest),
        /safe relative path/i,
      );
    }
  });

  it("rejects Windows drive-relative paths before fingerprint resolution", () => {
    const root = makeTempRoot();
    for (const driveRelativePath of ["C:foo", "C:", "a/C:foo", "a/C:"]) {
      assert.throws(
        () => fingerprintFiles(root, [driveRelativePath]),
        /safe relative path/i,
      );
    }
  });

  it("sorts warm files, initial files, and repeats before serialization", () => {
    const parsed = JSON.parse(serializeRunManifest(makeUnsortedWarmManifest()));
    assert.deepStrictEqual(
      parsed.inputs.warmSnapshot.files.map(
        (file: HashedArtifactFile) => file.path,
      ),
      [
        "inputs/warm-db/repository.lbug",
        "inputs/warm-db/repository.lbug.wal",
      ],
    );
    assert.deepStrictEqual(
      parsed.repeats.map((repeat: { repeat: number }) => repeat.repeat),
      [1, 2],
    );
    assert.deepStrictEqual(
      parsed.repeats[0].initialDbFiles.map(
        (file: InitialDbFile) => file.destinationPath,
      ),
      ["db/repeat-001.lbug", "db/repeat-001.lbug.wal"],
    );
  });

  it("hashes the exact serialized manifest bytes", () => {
    const bytes = serializeRunManifest(makeManifest());
    assert.equal(
      hashSerializedManifest(bytes),
      createHash("sha256").update(bytes, "utf8").digest("hex"),
    );
    assert.notEqual(
      hashSerializedManifest(bytes),
      createHash("sha256").update(bytes.slice(0, -1), "utf8").digest("hex"),
    );
  });

  it("serializes external benchmark results with fixed top-level order", () => {
    const results: ExternalBenchmarkResults = {
      schemaVersion: 1,
      runManifestSha256: SHA_A,
      passed: false,
      repeats: [],
    };
    const serialized = serializeExternalBenchmarkResults(results);

    assert.ok(serialized.endsWith("\n"));
    assert.deepStrictEqual(Object.keys(JSON.parse(serialized)), [
      "schemaVersion",
      "runManifestSha256",
      "passed",
      "repeats",
    ]);
  });
});

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sdl-external-manifest-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeMetrics(): ExternalBenchmarkMetricEvidence {
  return {
    indexTimePerFile: 1,
    indexTimePerSymbol: 2,
    symbolsPerFile: 3,
    edgesPerSymbol: 4,
    graphConnectivity: 5,
    exportedSymbolRatio: 6,
    sliceBuildTimeMs: 7,
    avgSkeletonTimeMs: 8,
    avgCardTokens: 9,
    avgSkeletonTokens: 10,
    functionMethodRatio: 11,
    avgDepsPerSymbol: 12,
    callEdgeCount: 13,
    importEdgeCount: 14,
    totalSymbols: 15,
    totalFiles: 16,
    summaryGenerationMs: 17,
    summaryTokens: 18,
    healthScore: null,
    watcherEventsProcessed: 20,
    watcherErrors: 21,
  };
}

function makePassingRawRepeat(
  repeat: number,
  metricNames: string[] = ["indexTimePerFile"],
): ExternalBenchmarkRawRepeat {
  const suffix = String(repeat).padStart(3, "0");
  return {
    repeat,
    exitCode: 0,
    failureBoundary: null,
    durationMs: repeat * 100,
    benchmarkResultPath: `raw/repeat-${suffix}.benchmark.json`,
    benchmarkResultSha256: SHA_B,
    benchmarkResult: {
      timestamp: "not-copied",
      repoPath: "F:/not-copied",
      config: {
        thresholdPath: "F:/not-copied/threshold.json",
        lockedRepos: ["not-copied"],
      },
      metrics: makeMetrics(),
      thresholdResult: {
        evaluations: metricNames.map((metricName) => ({
          metricName,
          category: metricName === "edgesPerSymbol" ? "graph" : "latency",
          currentValue: 1,
          passed: true,
          message: "within threshold",
        })),
      },
    },
  };
}

describe("external benchmark fingerprints", () => {
  it("fingerprints raw launcher and regular file bytes in sorted path order", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "nested"));
    const launcherBytes = Buffer.from([35, 33, 47, 117, 115, 114, 47, 98, 105, 110, 47, 101, 110, 118, 32, 110, 111, 100, 101, 13, 10]);
    writeFileSync(join(root, "launcher.mjs"), launcherBytes);
    writeFileSync(join(root, "nested", "data.bin"), Buffer.from([0, 255, 10]));

    assert.equal(
      sha256File(join(root, "launcher.mjs")),
      createHash("sha256").update(launcherBytes).digest("hex"),
    );

    const fingerprint = fingerprintFiles(root, [
      "nested/data.bin",
      "launcher.mjs",
    ]);
    assert.deepStrictEqual(
      fingerprint.files.map((file) => file.path),
      ["launcher.mjs", "nested/data.bin"],
    );
    assert.equal(
      fingerprint.files[1]?.sha256,
      createHash("sha256").update(Buffer.from([0, 255, 10])).digest("hex"),
    );
    assert.equal(
      fingerprint.sha256,
      createHash("sha256")
        .update(JSON.stringify(fingerprint.files), "utf8")
        .digest("hex"),
    );
    assert.throws(() => fingerprintFiles(root, ["nested"]), /not a file/i);
  });

  it("fingerprints symbolic links by raw link text for target trees", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "target.txt"), "target bytes");
    symlinkSync("target.txt", join(root, "target-link.txt"), "file");

    const fingerprint = fingerprintFiles(root, ["target-link.txt"]);

    assert.equal(
      fingerprint.files[0]?.sha256,
      createHash("sha256").update("target.txt", "utf8").digest("hex"),
    );
  });

  it("fingerprints build trees recursively and rejects symbolic links", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.js"), "one");
    writeFileSync(join(root, "nested", "b.js"), "two");

    const first = fingerprintDirectory(root);
    assert.deepStrictEqual(
      first.files.map((file) => file.path),
      ["a.js", "nested/b.js"],
    );

    writeFileSync(join(root, "nested", "b.js"), "changed");
    const second = fingerprintDirectory(root);
    assert.notEqual(first.sha256, second.sha256);

    symlinkSync("a.js", join(root, "linked.js"), "file");
    assert.throws(() => fingerprintDirectory(root), /symbolic link/i);
  });
});

describe("external benchmark result normalization", () => {
  it("sorts threshold evidence, nulls absent numbers, and references the manifest hash", () => {
    const results = buildExternalBenchmarkResults(SHA_A, 1, [
      makePassingRawRepeat(1, ["sliceBuildTimeMs", "edgesPerSymbol"]),
    ]);
    const serialized = serializeExternalBenchmarkResults(results);

    assert.equal(results.runManifestSha256, SHA_A);
    assert.equal(results.passed, true);
    assert.deepStrictEqual(
      results.repeats[0]?.thresholds.map((entry) => [
        entry.metricName,
        entry.category,
      ]),
      [
        ["edgesPerSymbol", "graph"],
        ["sliceBuildTimeMs", "latency"],
      ],
    );
    assert.equal(results.repeats[0]?.thresholds[0]?.baselineValue, null);
    assert.equal(results.repeats[0]?.thresholds[0]?.delta, null);
    assert.equal(results.repeats[0]?.thresholds[0]?.deltaPercent, null);
    assert.deepStrictEqual(Object.keys(results.repeats[0]?.metrics ?? {}), [
      "indexTimePerFile",
      "indexTimePerSymbol",
      "symbolsPerFile",
      "edgesPerSymbol",
      "graphConnectivity",
      "exportedSymbolRatio",
      "sliceBuildTimeMs",
      "avgSkeletonTimeMs",
      "avgCardTokens",
      "avgSkeletonTokens",
      "functionMethodRatio",
      "avgDepsPerSymbol",
      "callEdgeCount",
      "importEdgeCount",
      "totalSymbols",
      "totalFiles",
      "summaryGenerationMs",
      "summaryTokens",
      "healthScore",
      "watcherEventsProcessed",
      "watcherErrors",
    ]);
    assert.doesNotMatch(
      serialized,
      /not-copied|timestamp|repoPath|lockedRepos/,
    );
  });

  it("synthesizes every missing repeat and cannot pass a partial run", () => {
    const results = buildExternalBenchmarkResults(
      SHA_A,
      3,
      [makePassingRawRepeat(1)],
      { boundary: "preflight-between-repeats", failedRepeat: 2 },
    );

    assert.equal(results.passed, false);
    assert.equal(results.repeats.length, 3);
    assert.equal(results.repeats[1]?.repeat, 2);
    assert.equal(
      results.repeats[1]?.failureBoundary,
      "preflight-between-repeats",
    );
    assert.equal(results.repeats[1]?.benchmarkResultSha256, null);
    assert.equal(results.repeats[2]?.repeat, 3);
    assert.equal(
      results.repeats[2]?.failureBoundary,
      "unexecuted-after-failure",
    );
  });

  it("serializes failure boundary directly after exitCode", () => {
    const results = buildExternalBenchmarkResults(
      SHA_A,
      2,
      [],
      { boundary: "child-spawn", failedRepeat: 1 },
    );
    const parsed = JSON.parse(serializeExternalBenchmarkResults(results));

    assert.deepStrictEqual(Object.keys(parsed.repeats[0]), [
      "repeat",
      "exitCode",
      "failureBoundary",
      "durationMs",
      "benchmarkResultPath",
      "benchmarkResultSha256",
      "metrics",
      "thresholds",
      "passed",
    ]);
  });

  it("requires strict threshold evidence and a structurally complete repeat to pass", () => {
    const noThresholds = makePassingRawRepeat(1, []);
    const failingThreshold = makePassingRawRepeat(1);
    failingThreshold.benchmarkResult!.thresholdResult!.evaluations[0]!.passed =
      false;
    const missingHash = makePassingRawRepeat(1);
    missingHash.benchmarkResultSha256 = null;

    assert.equal(
      buildExternalBenchmarkResults(SHA_A, 1, [noThresholds]).passed,
      false,
    );
    assert.equal(
      buildExternalBenchmarkResults(SHA_A, 1, [failingThreshold]).passed,
      false,
    );
    assert.equal(
      buildExternalBenchmarkResults(SHA_A, 1, [missingHash]).passed,
      false,
    );
  });
});
