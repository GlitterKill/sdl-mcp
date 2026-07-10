import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  fingerprintDirectory,
  fingerprintFiles,
  type ExternalBenchmarkRunManifest,
} from "../../dist/benchmark/external-manifest.js";
import {
  assertCanonicalPathContained,
  assertCanonicalPathEqual,
  assertChildEnvironment,
  assertDbFamilyAbsent,
  assertGitSnapshot,
  assertManifestFileHashes,
  assertRunnerSnapshot,
  assertTargetRef,
  buildChildEnvironment,
  buildGeneratedRunConfig,
  canonicalizePath,
  collectDbFamilyFiles,
  fingerprintDbFamily,
  prepareColdRepeat,
  readGitSnapshot,
  prepareWarmRepeat,
  stageWarmSnapshot,
  validateBaselineV1,
  validateGeneratedRunConfig,
  validateThresholdConfigV1,
  validateThresholdFiles,
} from "../../dist/benchmark/external-runner.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sdl-external-runner-"));
  tempRoots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("external benchmark runner preflight", () => {
  it("collects the exact database family as sorted regular files", () => {
    const root = makeTempRoot();
    const primary = join(root, "repository.lbug");
    const expectedNames = [
      "repository.lbug",
      "repository.lbug.metadata",
      "repository.lbug.wal",
      "repository.lbug.wal.checkpoint",
    ];

    for (const name of expectedNames.toReversed()) {
      writeFileSync(join(root, name), name);
    }
    writeFileSync(join(root, "repository.lbug-other"), "ignored");
    writeFileSync(join(root, "unrelated"), "ignored");

    assert.deepStrictEqual(
      collectDbFamilyFiles(primary).map((filePath) => basename(filePath)),
      expectedNames,
    );
  });

  it("asserts database family absence and rejects non-regular family entries", () => {
    const root = makeTempRoot();
    const primary = join(root, "repository.lbug");

    assert.doesNotThrow(() => assertDbFamilyAbsent(primary));
    writeFileSync(primary + ".wal", "wal");
    assert.throws(() => assertDbFamilyAbsent(primary), /must be absent/u);

    rmSync(primary + ".wal");
    mkdirSync(primary + ".metadata");
    assert.throws(() => fingerprintDbFamily(primary), /regular file/u);
  });

  it("fingerprints database family membership and raw bytes", () => {
    const root = makeTempRoot();
    const primary = join(root, "repository.lbug");
    writeFileSync(primary, "primary");
    writeFileSync(primary + ".wal", "wal");

    const first = fingerprintDbFamily(primary);
    assert.deepStrictEqual(first.files, [
      { path: "repository.lbug", sha256: sha256("primary") },
      { path: "repository.lbug.wal", sha256: sha256("wal") },
    ]);
    assert.equal(
      first.sha256,
      createHash("sha256")
        .update(JSON.stringify(first.files), "utf8")
        .digest("hex"),
    );

    writeFileSync(primary + ".wal", "changed");
    const contentChanged = fingerprintDbFamily(primary);
    assert.deepStrictEqual(
      contentChanged.files.map(({ path }) => path),
      first.files.map(({ path }) => path),
    );
    assert.notEqual(contentChanged.files[1]?.sha256, first.files[1]?.sha256);
    assert.notEqual(contentChanged.sha256, first.sha256);

    writeFileSync(primary + ".metadata", "metadata");
    const membershipChanged = fingerprintDbFamily(primary);
    assert.notDeepStrictEqual(
      membershipChanged.files.map(({ path }) => path),
      contentChanged.files.map(({ path }) => path),
    );
    assert.notEqual(membershipChanged.sha256, contentChanged.sha256);
  });
});

describe("cold repeat isolation", () => {
  it("prepares distinct absent cold database families without changing state", (t) => {
    const root = makeTempRoot();
    const dbDirectory = join(root, "db");
    const remove = t.mock.method(fs, "rmSync");

    assert.equal(existsSync(dbDirectory), false);
    assert.deepStrictEqual(prepareColdRepeat(root, 1), {
      graphDbPath: "db/repeat-001.lbug",
      initialDbFiles: [],
    });
    assert.deepStrictEqual(prepareColdRepeat(root, 2), {
      graphDbPath: "db/repeat-002.lbug",
      initialDbFiles: [],
    });
    assert.equal(existsSync(dbDirectory), false);
    assert.equal(remove.mock.callCount(), 0);
  });

  it("rejects every existing cold family member without changing it", (t) => {
    const remove = t.mock.method(fs, "rmSync");
    const suffixes = ["", ".wal", ".wal.checkpoint", ".metadata"];

    for (const suffix of suffixes) {
      const root = makeTempRoot();
      const dbDirectory = join(root, "db");
      mkdirSync(dbDirectory);
      const existingPath = join(dbDirectory, "repeat-001.lbug" + suffix);
      writeFileSync(existingPath, suffix || "primary");

      assert.throws(() => prepareColdRepeat(root, 1), /must be absent/u);
      assert.equal(fs.readFileSync(existingPath, "utf8"), suffix || "primary");
    }

    assert.equal(remove.mock.callCount(), 0);
  });
});

function makeWarmFixture() {
  const root = makeTempRoot();
  const sourceDirectory = join(root, "source");
  const sourcePrimary = join(sourceDirectory, "source.lbug");
  mkdirSync(sourceDirectory);
  mkdirSync(join(root, "inputs"));
  mkdirSync(join(root, "db"));
  writeFileSync(sourcePrimary, "primary");
  writeFileSync(sourcePrimary + ".wal", "wal");
  return { root, sourcePrimary };
}

describe("warm repeat isolation", () => {
  it("stages and prepares sorted exclusive warm families", (t) => {
    const { root, sourcePrimary } = makeWarmFixture();
    const remove = t.mock.method(fs, "rmSync");
    const snapshot = stageWarmSnapshot(sourcePrimary, root);

    assert.deepStrictEqual(snapshot.files, [
      { path: "inputs/warm-db/repository.lbug", sha256: sha256("primary") },
      { path: "inputs/warm-db/repository.lbug.wal", sha256: sha256("wal") },
    ]);
    const first = prepareWarmRepeat(root, 1, snapshot);
    const second = prepareWarmRepeat(root, 2, snapshot);
    assert.deepStrictEqual(first, {
      graphDbPath: "db/repeat-001.lbug",
      initialDbFiles: [
        {
          sourcePath: "inputs/warm-db/repository.lbug",
          destinationPath: "db/repeat-001.lbug",
          sha256: sha256("primary"),
        },
        {
          sourcePath: "inputs/warm-db/repository.lbug.wal",
          destinationPath: "db/repeat-001.lbug.wal",
          sha256: sha256("wal"),
        },
      ],
    });
    assert.equal(second.graphDbPath, "db/repeat-002.lbug");
    assert.equal(
      first.initialDbFiles.some(({ destinationPath }) =>
        second.initialDbFiles.some(
          (candidate) => candidate.destinationPath === destinationPath,
        ),
      ),
      false,
    );
    assert.equal(
      fs.readFileSync(join(root, "db", "repeat-001.lbug.wal"), "utf8"),
      "wal",
    );
    assert.equal(remove.mock.callCount(), 0);
  });

  it("rejects an existing warm staging directory or repeat family", (t) => {
    const first = makeWarmFixture();
    const warmDirectory = join(first.root, "inputs", "warm-db");
    mkdirSync(warmDirectory);
    writeFileSync(join(warmDirectory, "sentinel"), "keep");
    const remove = t.mock.method(fs, "rmSync");

    assert.throws(
      () => stageWarmSnapshot(first.sourcePrimary, first.root),
      /already exists|EEXIST/u,
    );
    assert.equal(fs.readFileSync(join(warmDirectory, "sentinel"), "utf8"), "keep");

    const second = makeWarmFixture();
    const snapshot = stageWarmSnapshot(second.sourcePrimary, second.root);
    const existing = join(second.root, "db", "repeat-001.lbug.metadata");
    writeFileSync(existing, "keep");
    assert.throws(
      () => prepareWarmRepeat(second.root, 1, snapshot),
      /must be absent/u,
    );
    assert.equal(fs.readFileSync(existing, "utf8"), "keep");
    assert.equal(remove.mock.callCount(), 0);
  });

  it("rejects changed staged bytes before copying a warm repeat", (t) => {
    const { root, sourcePrimary } = makeWarmFixture();
    const snapshot = stageWarmSnapshot(sourcePrimary, root);
    const stagedWal = join(root, "inputs", "warm-db", "repository.lbug.wal");
    writeFileSync(stagedWal, "changed");
    const remove = t.mock.method(fs, "rmSync");

    assert.throws(
      () => prepareWarmRepeat(root, 1, snapshot),
      /staged warm input hash changed/u,
    );
    assert.equal(existsSync(join(root, "db", "repeat-001.lbug")), false);
    assert.equal(remove.mock.callCount(), 0);
  });

  it("verifies every copied warm repeat byte without cleanup", (t) => {
    const { root, sourcePrimary } = makeWarmFixture();
    const snapshot = stageWarmSnapshot(sourcePrimary, root);
    const copy = t.mock.method(fs, "copyFileSync", (_source, destination) => {
      writeFileSync(destination, "corrupt");
    });
    const remove = t.mock.method(fs, "rmSync");

    assert.throws(
      () => prepareWarmRepeat(root, 1, snapshot),
      /copied warm input hash mismatch/u,
    );
    assert.equal(
      fs.readFileSync(join(root, "db", "repeat-001.lbug"), "utf8"),
      "corrupt",
    );
    assert.ok(copy.mock.callCount() > 0);
    assert.equal(remove.mock.callCount(), 0);
  });

  for (const [label, mutate] of [
    ["changed", (primary: string) => writeFileSync(primary + ".wal", "changed")],
    ["added", (primary: string) => writeFileSync(primary + ".metadata", "added")],
    ["removed", (primary: string) => fs.unlinkSync(primary + ".wal")],
  ] as const) {
    it(`rejects ${label} warm source sidecars after staging without cleanup`, (t) => {
      const { root, sourcePrimary } = makeWarmFixture();
      const copyFile = fs.copyFileSync.bind(fs);
      let copied = 0;
      const copy = t.mock.method(
        fs,
        "copyFileSync",
        (source, destination, mode) => {
          copyFile(source, destination, mode);
          copied += 1;
          if (copied === 2) mutate(sourcePrimary);
        },
      );
      const remove = t.mock.method(fs, "rmSync");

      assert.throws(
        () => stageWarmSnapshot(sourcePrimary, root),
        /warm source changed during staging/u,
      );
      assert.ok(copy.mock.callCount() > 0);
      assert.equal(
        existsSync(join(root, "inputs", "warm-db", "repository.lbug")),
        true,
      );
      assert.equal(remove.mock.callCount(), 0);
    });
  }
});

const HASH_A = "a".repeat(64);

function makePreflightManifest(): ExternalBenchmarkRunManifest {
  return {
    schemaVersion: 1,
    target: {
      repoId: "target",
      sourceRef: "locked",
      sourceCommit: "1".repeat(40),
      sourceDirty: false,
      sourceTreeSha256: HASH_A,
      scipArtifactPath: null,
      scipArtifactSha256: null,
    },
    runner: {
      sdlMcpVersion: "0.12.2",
      sdlMcpCommit: "2".repeat(40),
      sdlMcpSourceDirty: false,
      sdlMcpBuildTreeSha256: HASH_A,
      launcherPath: "scripts/external-benchmark-runner.mjs",
      launcherSha256: HASH_A,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      cacheMode: "cold",
      repeats: 1,
    },
    inputs: {
      configPath: "inputs/sdlmcp.config.json",
      configSha256: HASH_A,
      baselinePath: "inputs/baseline.json",
      baselineSha256: HASH_A,
      baselineFormatVersion: "1",
      baselineTargetRepoId: "target",
      thresholdSourcePath: "config/benchmark.config.json",
      thresholdPath: "inputs/threshold.json",
      thresholdSha256: HASH_A,
      warmSnapshot: null,
    },
    repeats: [
      {
        repeat: 1,
        graphDbPath: "db/repeat-001.lbug",
        stdoutPath: "logs/repeat-001.stdout.log",
        stderrPath: "logs/repeat-001.stderr.log",
        initialDbFiles: [],
        command: [],
      },
    ],
  };
}

function validMetrics() {
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
  };
}

function validThresholdConfig() {
  const lower = (maxKey: "maxMs" | "maxTokens", value: number) => ({
    [maxKey]: value,
    trend: "lower-is-better",
    allowableIncreasePercent: 10,
  });
  const higher = {
    minValue: 1,
    trend: "higher-is-better",
    allowableDecreasePercent: 10,
  };
  return {
    version: "1.0",
    thresholds: {
      indexing: {
        indexTimePerFile: lower("maxMs", 1),
        indexTimePerSymbol: lower("maxMs", 2),
      },
      quality: {
        symbolsPerFile: higher,
        edgesPerSymbol: higher,
        graphConnectivity: higher,
        exportedSymbolRatio: higher,
      },
      performance: {
        sliceBuildTimeMs: lower("maxMs", 3),
        avgSkeletonTimeMs: lower("maxMs", 4),
      },
      tokenEfficiency: {
        avgCardTokens: lower("maxTokens", 5),
        avgSkeletonTokens: lower("maxTokens", 6),
      },
    },
  };
}

describe("canonical paths and child environment", () => {
  it("canonicalizes contained existing roots and absent children", () => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    mkdirSync(join(root, "db"));

    assertCanonicalPathEqual(root, resolve(root, "."));
    assertCanonicalPathContained(root, join(root, "db", "new.lbug"));
    assert.throws(
      () => assertCanonicalPathContained(root, join(outside, "new.lbug")),
      /contained/u,
    );
    assert.equal(
      canonicalizePath(join(root, "db", "new.lbug")),
      canonicalizePath(join(root, "db", ".", "new.lbug")),
    );
  });

  it("rejects canonical symlink or junction escapes", (t) => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    const link = join(root, "escape");
    mkdirSync(join(outside, "db"));
    try {
      fs.symlinkSync(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        t.skip("symlink or junction creation is not permitted");
        return;
      }
      throw error;
    }

    assert.throws(
      () =>
        assertCanonicalPathContained(
          root,
          join(link, "db", "repeat-001.lbug"),
        ),
      /contained/u,
    );
  });

  it("sanitizes inherited SDL variables before exact assignment", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "inputs"));
    mkdirSync(join(root, "db"));
    const config = join(root, "inputs", "sdlmcp.config.json");
    const database = join(root, "db", "repeat-001.lbug");
    writeFileSync(config, "{}");
    const inherited = {
      KEEP: "yes",
      SDL_GRAPH_DB_DIR: "old-dir",
      SDL_GRAPH_DB_PATH: "old-db",
      SDL_DB_PATH: "other-db",
      SDL_CONFIG: "old-config",
    };

    const env = buildChildEnvironment(inherited, config, database);
    assert.deepStrictEqual(env, {
      KEEP: "yes",
      SDL_CONFIG: config,
      SDL_GRAPH_DB_PATH: database,
      SDL_DB_PATH: database,
    });
    const used = new Set<string>();
    assertChildEnvironment(
      env,
      root,
      makePreflightManifest(),
      makePreflightManifest().repeats[0]!,
      used,
    );
    assert.equal(used.size, 1);
  });

  it("prevents child execution for every environment mismatch or reuse", () => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    mkdirSync(join(root, "inputs"));
    mkdirSync(join(root, "db"));
    const config = join(root, "inputs", "sdlmcp.config.json");
    const database = join(root, "db", "repeat-001.lbug");
    writeFileSync(config, "{}");
    const valid = buildChildEnvironment({}, config, database);
    const manifest = makePreflightManifest();
    const repeat = manifest.repeats[0]!;
    const cases: Array<[NodeJS.ProcessEnv, Set<string>]> = [
      [{ ...valid, SDL_GRAPH_DB_DIR: "reintroduced" }, new Set()],
      [{ ...valid, SDL_CONFIG: undefined }, new Set()],
      [{ ...valid, SDL_CONFIG: join(outside, "other.json") }, new Set()],
      [{ ...valid, SDL_GRAPH_DB_PATH: undefined }, new Set()],
      [{ ...valid, SDL_GRAPH_DB_PATH: join(outside, "escape.lbug") }, new Set()],
      [{ ...valid, SDL_DB_PATH: join(root, "db", "other.lbug") }, new Set()],
      [valid, new Set([canonicalizePath(database)])],
    ];

    for (const [env, used] of cases) {
      let calls = 0;
      assert.throws(() => {
        assertChildEnvironment(env, root, manifest, repeat, used);
        calls += 1;
      });
      assert.equal(calls, 0);
    }
  });
});

describe("target baseline and threshold validation", () => {
  it("requires the exact target and ten finite baseline metrics", () => {
    const valid = {
      formatVersion: 1,
      repoId: "target",
      metrics: validMetrics(),
    };
    assert.deepStrictEqual(validateBaselineV1(valid, "target"), valid);

    const { avgSkeletonTokens: _omitted, ...missingMetric } = validMetrics();
    const invalid = [
      { ...valid, formatVersion: 2 },
      { ...valid, repoId: "other" },
      { ...valid, metrics: missingMetric },
      {
        ...valid,
        metrics: { ...validMetrics(), indexTimePerFile: Number.NaN },
      },
      { ...valid, metrics: { ...validMetrics(), unexpected: 1 } },
    ];
    for (const candidate of invalid) {
      let calls = 0;
      assert.throws(() => {
        validateBaselineV1(candidate, "target");
        calls += 1;
      });
      assert.equal(calls, 0);
    }
  });

  it("requires version 1.0 and the ten threshold contracts", () => {
    const pairs = validateThresholdConfigV1(validThresholdConfig());
    assert.deepStrictEqual(pairs, [
      "indexing/indexTimePerFile",
      "indexing/indexTimePerSymbol",
      "performance/avgSkeletonTimeMs",
      "performance/sliceBuildTimeMs",
      "quality/edgesPerSymbol",
      "quality/exportedSymbolRatio",
      "quality/graphConnectivity",
      "quality/symbolsPerFile",
      "tokenEfficiency/avgCardTokens",
      "tokenEfficiency/avgSkeletonTokens",
    ]);

    const wrongVersion = structuredClone(validThresholdConfig());
    wrongVersion.version = "2.0";
    const empty = { version: "1.0", thresholds: {} };
    const missing = structuredClone(validThresholdConfig());
    delete missing.thresholds.quality.edgesPerSymbol;
    const wrongTrend = structuredClone(validThresholdConfig());
    wrongTrend.thresholds.quality.edgesPerSymbol.trend = "lower-is-better";
    const badAbsolute = structuredClone(validThresholdConfig());
    badAbsolute.thresholds.indexing.indexTimePerFile.maxMs = Number.NaN;
    const badAllowance = structuredClone(validThresholdConfig());
    badAllowance.thresholds.tokenEfficiency.avgCardTokens
      .allowableIncreasePercent = Number.POSITIVE_INFINITY;
    const extraCategory = structuredClone(validThresholdConfig());
    extraCategory.thresholds.coverage = {};
    const extraMetric = structuredClone(validThresholdConfig());
    extraMetric.thresholds.quality.unexpected = {
      minValue: 1,
      trend: "higher-is-better",
      allowableDecreasePercent: 10,
    };
    const extraRuleField = structuredClone(validThresholdConfig());
    extraRuleField.thresholds.indexing.indexTimePerFile.unexpected = true;

    for (const candidate of [
      wrongVersion,
      empty,
      missing,
      wrongTrend,
      badAbsolute,
      badAllowance,
      extraCategory,
      extraMetric,
      extraRuleField,
    ]) {
      let calls = 0;
      assert.throws(() => {
        validateThresholdConfigV1(candidate);
        calls += 1;
      });
      assert.equal(calls, 0);
    }
  });

  it("requires threshold source and staged bytes to be identical", () => {
    const root = makeTempRoot();
    const source = join(root, "source.json");
    const staged = join(root, "staged.json");
    const bytes = JSON.stringify(validThresholdConfig());
    writeFileSync(source, bytes);
    writeFileSync(staged, bytes);

    assert.deepStrictEqual(validateThresholdFiles(source, staged), {
      sha256: sha256(bytes),
      pairs: validateThresholdConfigV1(validThresholdConfig()),
    });
    writeFileSync(staged, bytes + "\n");
    assert.throws(
      () => validateThresholdFiles(source, staged),
      /byte-identical/u,
    );
    writeFileSync(source, "{not-json");
    assert.throws(() => validateThresholdFiles(source, staged), /parse/u);
  });
});

describe("target config and launcher evidence", () => {
  it("builds exactly one unwatched target and validates its canonical root", () => {
    const root = makeTempRoot();
    const target = join(root, "target");
    const other = join(root, "other");
    mkdirSync(target);
    mkdirSync(other);
    const basePath = join(root, "base.json");
    const externalPath = join(root, "external.json");
    writeFileSync(
      basePath,
      JSON.stringify({
        repos: [{ repoId: "old", rootPath: other }],
        indexing: { concurrency: 4, enableFileWatching: true },
        policy: { maxWindowLines: 10 },
      }),
    );
    writeFileSync(
      externalPath,
      JSON.stringify({
        repos: [
          { repoId: "other", rootPath: other },
          { repoId: "target", rootPath: target, languages: ["ts"] },
        ],
      }),
    );

    const config = buildGeneratedRunConfig(basePath, externalPath, "target");
    assert.deepStrictEqual(config.repos, [
      { repoId: "target", rootPath: target, languages: ["ts"] },
    ]);
    assert.deepStrictEqual(config.indexing, {
      concurrency: 4,
      enableFileWatching: false,
    });
    assert.deepStrictEqual(config.policy, { maxWindowLines: 10 });
    assert.doesNotThrow(() =>
      validateGeneratedRunConfig(config, "target", target, root),
    );

    let calls = 0;
    assert.throws(() => {
      validateGeneratedRunConfig(config, "target", other, root);
      calls += 1;
    });
    assert.equal(calls, 0);
  });

  it("rejects duplicate targets and non-exact generated configs", () => {
    const root = makeTempRoot();
    const target = join(root, "target");
    mkdirSync(target);
    const basePath = join(root, "base.json");
    const externalPath = join(root, "external.json");
    writeFileSync(
      basePath,
      JSON.stringify({ repos: [], indexing: { enableFileWatching: true } }),
    );
    writeFileSync(
      externalPath,
      JSON.stringify({
        repos: [
          { repoId: "target", rootPath: target },
          { repoId: "target", rootPath: target },
        ],
      }),
    );
    assert.throws(
      () => buildGeneratedRunConfig(basePath, externalPath, "target"),
      /exactly one/u,
    );
    assert.throws(
      () =>
        validateGeneratedRunConfig(
          {
            repos: [
              { repoId: "target", rootPath: target },
              { repoId: "other", rootPath: target },
            ],
            indexing: { enableFileWatching: false },
          },
          "target",
          target,
          root,
        ),
      /exactly one/u,
    );
  });

  it("matches launcher and staged manifest hashes before a child can run", () => {
    const runner = makeTempRoot();
    const artifact = makeTempRoot();
    mkdirSync(join(runner, "scripts"));
    mkdirSync(join(runner, "config"));
    mkdirSync(join(artifact, "inputs"));
    const manifest = makePreflightManifest();
    const files = [
      [join(runner, manifest.runner.launcherPath), "launcher"],
      [join(runner, manifest.inputs.thresholdSourcePath), "threshold"],
      [join(artifact, manifest.inputs.configPath), "config"],
      [join(artifact, manifest.inputs.baselinePath), "baseline"],
      [join(artifact, manifest.inputs.thresholdPath), "threshold"],
    ] as const;
    for (const [filePath, bytes] of files) writeFileSync(filePath, bytes);
    manifest.runner.launcherSha256 = sha256("launcher");
    manifest.inputs.configSha256 = sha256("config");
    manifest.inputs.baselineSha256 = sha256("baseline");
    manifest.inputs.thresholdSha256 = sha256("threshold");

    assert.doesNotThrow(() =>
      assertManifestFileHashes(runner, artifact, manifest),
    );
    writeFileSync(join(runner, manifest.runner.launcherPath), "changed");
    let calls = 0;
    assert.throws(() => {
      assertManifestFileHashes(runner, artifact, manifest);
      calls += 1;
    }, /launcher/u);
    assert.equal(calls, 0);
  });
});

describe("target and runner git snapshots", () => {
  it("uses exact git argv and fingerprints the reported file set", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "tracked.txt"), "tracked");
    const commit = "1".repeat(40);
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = (file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] });
      const command = args.slice(2).join(" ");
      if (command === "rev-parse HEAD") return commit + "\n";
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "ls-files --cached --others --exclude-standard -z") {
        return "tracked.txt\0";
      }
      throw new Error("unexpected git command: " + command);
    };

    const snapshot = readGitSnapshot(root, exec);
    assert.deepStrictEqual(snapshot, {
      commit,
      dirty: false,
      treeSha256: fingerprintFiles(root, ["tracked.txt"]).sha256,
    });
    assert.deepStrictEqual(calls, [
      { file: "git", args: ["-C", root, "rev-parse", "HEAD"] },
      {
        file: "git",
        args: [
          "-C",
          root,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ],
      },
      {
        file: "git",
        args: [
          "-C",
          root,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ],
      },
    ]);
  });

  it("requires locked target commit, origin, dirty state, and tree", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "tracked.txt"), "tracked");
    const commit = "1".repeat(40);
    const cloneUrl = "https://example.invalid/repo.git";
    const calls: string[][] = [];
    const exec = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      const command = args.slice(2).join(" ");
      if (command === "rev-parse HEAD") return commit;
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "ls-files --cached --others --exclude-standard -z") {
        return "tracked.txt\0";
      }
      if (command === "rev-parse --verify locked^{commit}") return commit;
      if (command === "remote get-url origin") return cloneUrl + "/";
      throw new Error("unexpected git command: " + command);
    };

    const snapshot = assertTargetRef(
      root,
      { ref: "locked", cloneUrl },
      exec,
    );
    assertGitSnapshot(snapshot, {
      commit,
      dirty: false,
      treeSha256: fingerprintFiles(root, ["tracked.txt"]).sha256,
    }, "target");
    assert.ok(
      calls.some(
        (args) => args.join(" ") ===
          ["-C", root, "rev-parse", "--verify", "locked^{commit}"].join(" "),
      ),
    );
    assert.ok(
      calls.some(
        (args) => args.join(" ") ===
          ["-C", root, "remote", "get-url", "origin"].join(" "),
      ),
    );
  });

  it("matches runner commit, dirtiness, tree, dist, and launcher", () => {
    const root = makeTempRoot();
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "tracked.txt"), "tracked");
    writeFileSync(join(root, "dist", "app.js"), "dist");
    writeFileSync(
      join(root, "scripts", "external-benchmark-runner.mjs"),
      "launcher",
    );
    const manifest = makePreflightManifest();
    manifest.runner.sdlMcpCommit = "2".repeat(40);
    manifest.runner.sdlMcpBuildTreeSha256 =
      fingerprintDirectory(join(root, "dist")).sha256;
    manifest.runner.launcherSha256 = sha256("launcher");
    const exec = (_file: string, args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "rev-parse HEAD") return manifest.runner.sdlMcpCommit;
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "ls-files --cached --others --exclude-standard -z") {
        return "tracked.txt\0";
      }
      throw new Error("unexpected git command: " + command);
    };
    const expected = readGitSnapshot(root, exec);
    assert.doesNotThrow(() =>
      assertRunnerSnapshot(root, manifest, expected, exec),
    );

    writeFileSync(join(root, "dist", "app.js"), "changed");
    let calls = 0;
    assert.throws(() => {
      assertRunnerSnapshot(root, manifest, expected, exec);
      calls += 1;
    }, /dist/u);
    assert.equal(calls, 0);
  });

  it("blocks target ref and snapshot mismatches before child execution", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "tracked.txt"), "tracked");
    const commit = "1".repeat(40);
    const treeSha256 = fingerprintFiles(root, ["tracked.txt"]).sha256;
    const exec = (_file: string, args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      if (command === "rev-parse HEAD") return commit;
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "ls-files --cached --others --exclude-standard -z") {
        return "tracked.txt\0";
      }
      if (command === "rev-parse --verify locked^{commit}") return "2".repeat(40);
      if (command === "remote get-url origin") {
        return "https://example.invalid/repo.git";
      }
      throw new Error("unexpected git command: " + command);
    };
    let calls = 0;
    assert.throws(() => {
      assertTargetRef(
        root,
        { ref: "locked", cloneUrl: "https://example.invalid/repo.git" },
        exec,
      );
      calls += 1;
    }, /locked/u);
    assert.equal(calls, 0);

    const actual = { commit, dirty: false, treeSha256 };
    for (const expected of [
      { ...actual, commit: "3".repeat(40) },
      { ...actual, dirty: true },
      { ...actual, treeSha256: HASH_A },
    ]) {
      calls = 0;
      assert.throws(() => {
        assertGitSnapshot(actual, expected, "target");
        calls += 1;
      });
      assert.equal(calls, 0);
    }
  });

  it("blocks a mismatched target origin before child execution", () => {
    const root = makeTempRoot();
    writeFileSync(join(root, "tracked.txt"), "tracked");
    const commit = "1".repeat(40);
    const exec = (_file: string, args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      if (
        command === "rev-parse HEAD" ||
        command === "rev-parse --verify locked^{commit}"
      ) {
        return commit;
      }
      if (command === "status --porcelain=v1 --untracked-files=all") return "";
      if (command === "ls-files --cached --others --exclude-standard -z") {
        return "tracked.txt\0";
      }
      if (command === "remote get-url origin") {
        return "https://example.invalid/wrong.git";
      }
      throw new Error("unexpected git command: " + command);
    };
    let childCallCount = 0;

    assert.throws(() => {
      assertTargetRef(
        root,
        { ref: "locked", cloneUrl: "https://example.invalid/expected.git" },
        exec,
      );
      childCallCount += 1;
    }, /origin/u);
    assert.equal(childCallCount, 0);
  });
});
