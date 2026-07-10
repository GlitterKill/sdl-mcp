# External Benchmark Isolation and Evidence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make locked external `benchmark:ci` runs target-aware, database-isolated, and reproducible through a byte-stable input manifest plus separately persisted run evidence.

**Architecture:** Keep `benchmark:ci` as the measurement engine and add a narrow wrapper around it. The wrapper selects one pinned external checkout, snapshots every reproducibility input, creates one fresh LadybugDB family per repeat, validates runner and target state immediately before child execution, and normalizes the child results into stable artifact-relative evidence without changing benchmark thresholds.

**Tech Stack:** TypeScript ESM, Node.js 24 standard library (`node:crypto`, `node:fs`, `node:path`, `node:child_process`), the existing `benchmark:ci` CLI, LadybugDB file families, `node:test`, and JSON.

---

## Chunk 1: External Benchmark Isolation and Evidence

### Scope and non-negotiable contracts

- The implementation does not modify `config/benchmark.config.json` or `config/benchmark.ci.config.json`. A failing threshold remains a failing run.
- The wrapper never uses `data/sdl-mcp-graph.lbug`, the configured default project database, or a database path inherited from another process. It removes inherited `SDL_GRAPH_DB_DIR`, `SDL_GRAPH_DB_PATH`, `SDL_DB_PATH`, and `SDL_CONFIG` before setting the three exact child values.
- The wrapper never deletes an existing database, WAL, sidecar, artifact root, log, or result file. Existing state is a preflight failure.
- `run-manifest.json` contains no timestamp, duration, session ID, random identifier, or machine-specific absolute path.
- Every manifest path uses forward slashes. Artifact paths are relative to the artifact root; runner-source paths in the logical command are repository-relative.
- Repeats use distinct `db/repeat-NNN.lbug` paths. Warm repeats copy a hashed input family and never share or mutate the warm snapshot.
- The manifest hashes the exact serialized bytes written to disk, including its final line feed. `results.json` stores that SHA-256. The manifest also hashes the executable launcher and an exclusive staged copy of the threshold file; both source and staged threshold bytes are revalidated before every child.
- The bounded `scip-io` smoke runs only after unit, build, lint, documentation, determinism, golden, and full-suite gates. Do not execute it while implementing the earlier tasks.
- The ignored `BACKLOG.md` item is checked only after a fresh smoke produces `results.json` with `passed: true`. A failed smoke records its evidence and leaves the item unchecked.

### Existing surface and planned file responsibilities

| Path | Change | Responsibility |
| --- | --- | --- |
| `scripts/setup-external-benchmark-repos.ts:42` | Modify | Continue loading pinned specs and generating external repo config; make the generated root paths repository-relative and stable. |
| `scripts/benchmark/matrix-external-repos.lock.json` | Modify | Add the exact `scip-io` remote and commit to the existing locked external-repository inventory. |
| `benchmarks/real-world/external-repos.config.json` | Modify | Keep the committed generated config in sync with the lock and add the stable `.tmp/external-benchmarks/scip-io` entry. |
| `tests/unit/setup-external-benchmark-repos.test.ts` | Modify | Lock the exact repo set, `scip-io` pin, and relative config path behavior. |
| `.benchmark/latest.json` | Read only | Existing ignored evidence from 2026-07-07; source of the target-matched ten-metric baseline. |
| `.benchmark/baseline.scip-io.json` | Create | Committed, minimal, versioned baseline for `scip-io`. It contains no timestamp or absolute path. |
| `.gitignore` | Modify | Unignore only `.benchmark/baseline.scip-io.json`; continue ignoring run artifacts. |
| `src/benchmark/output-file.ts` | Create | Own the two-mode UTF-8 writer: existing benchmark output keeps overwrite mode, while external evidence uses exclusive `wx` mode. |
| `src/benchmark/external-manifest.ts` | Create | Own manifest/result types, stable serialization, file/tree SHA-256 helpers, and fixed-order result normalization. |
| `src/benchmark/external-runner.ts` | Create | Own CLI options, lock/config/baseline/git validation, cold/warm DB family preparation, child environment validation, execution, and artifact persistence. |
| `scripts/external-benchmark-runner.mjs` | Create | Thin executable adapter that calls the built TypeScript runner and sets `process.exitCode`; its raw bytes are hashed into the manifest. |
| `scripts/verify-external-benchmark-evidence.mjs` | Create | Executable closeout verifier for manifest/result/input/raw-result hashes, expected target/cache/repeat semantics, relative paths, prohibited fields, and default-DB before/after fingerprints. |
| `tests/unit/external-benchmark-output.test.ts` | Create | Prove overwrite mode remains compatible and exclusive mode refuses a pre-existing or raced raw-output path. |
| `tests/unit/external-benchmark-manifest.test.ts` | Create | Prove byte stability, key/array order, manifest hashing, build-tree fingerprinting, and result threshold sorting. |
| `tests/unit/external-benchmark-runner.test.ts` | Create | Prove preflight refusal, exact target/runner matching, cold/warm isolation, no-delete behavior, child environment safety, and result persistence without running an external benchmark. |
| `package.json` | Modify | Add the explicit `benchmark:external` entry point. |
| `docs/benchmark-guardrails.md` | Modify | Document the external wrapper, cold/warm commands, artifact tree, and failure behavior. |
| `docs/benchmark-baseline-management.md` | Modify | Document versioned target-specific baselines and prohibit threshold weakening as a baseline workaround. |
| `devdocs/plans/notes/2026-07-05-token-economy-status.md` | Modify after smoke | Replace the stale `scip-io` baseline-mismatch statement with exact current artifact evidence. |
| `BACKLOG.md` | Local ignored update after smoke | Reconcile the benchmark item from fresh evidence; it is not a committed CI input. |

These existing files remain unchanged:

- `src/cli/commands/benchmark.ts:377` remains the measurement engine, but gains an internal `--out-exclusive` flag that selects the shared `wx` writer. Existing calls without the flag retain overwrite behavior.
- `src/benchmark/matrix-runner.ts:10` remains the real-world matrix helper. Its `graph-db/{encodedRepoId}/sdl-mcp-graph.lbug` layout cannot represent the required `db/repeat-NNN.lbug` cold/warm contract, so reusing it would couple two different artifact formats.
- `scripts/provider-first-fallback-benchmark.ts` remains the provider-first optimization harness. Its artifact-first pattern is a reference, but its sampled-file semantics do not replace `benchmark:ci`.
- `scripts/benchmark/phase-a-benchmark-lock.json` remains legacy metadata emitted by `benchmark:ci`. The external wrapper validates the target against `matrix-external-repos.lock.json` instead.
- `config/sdlmcp.config.json` remains the base runtime configuration.
- `config/benchmark.config.json` remains the local threshold source.
- `tests/unit/benchmark-baseline-repo.test.ts` continues to cover the core loader's repo mismatch behavior.
- `tests/unit/real-world-benchmark-matrix.test.ts` continues to cover the separate matrix DB layout.
- `.github/workflows/ci.yml` keeps the existing locked `zod-oss` guardrail. This track adds a bounded `scip-io` completion smoke, not another mandatory CI benchmark lane.

### Canonical data contracts

Create these exported contracts in `src/benchmark/external-manifest.ts`. Keep property declaration and object-construction order exactly as shown.

```typescript
export type ExternalBenchmarkCacheMode = "cold" | "warm";

export interface HashedArtifactFile {
  path: string;
  sha256: string;
}

export interface InitialDbFile {
  sourcePath: string;
  destinationPath: string;
  sha256: string;
}

export interface ExternalBenchmarkRepeatManifest {
  repeat: number;
  graphDbPath: string;
  stdoutPath: string;
  stderrPath: string;
  initialDbFiles: InitialDbFile[];
  command: string[];
}

export interface ExternalBenchmarkRunManifest {
  schemaVersion: 1;
  target: {
    repoId: string;
    sourceRef: string;
    sourceCommit: string;
    sourceDirty: boolean;
    sourceTreeSha256: string;
    scipArtifactPath: string | null;
    scipArtifactSha256: string | null;
  };
  runner: {
    sdlMcpVersion: string;
    sdlMcpCommit: string;
    sdlMcpSourceDirty: boolean;
    sdlMcpBuildTreeSha256: string;
    launcherPath: "scripts/external-benchmark-runner.mjs";
    launcherSha256: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    cacheMode: ExternalBenchmarkCacheMode;
    repeats: number;
  };
  inputs: {
    configPath: "inputs/sdlmcp.config.json";
    configSha256: string;
    baselinePath: "inputs/baseline.json";
    baselineSha256: string;
    baselineFormatVersion: "1";
    baselineTargetRepoId: string;
    thresholdSourcePath: "config/benchmark.config.json";
    thresholdPath: "inputs/threshold.json";
    thresholdSha256: string;
    warmSnapshot: { files: HashedArtifactFile[] } | null;
  };
  repeats: ExternalBenchmarkRepeatManifest[];
}

export interface ExternalBenchmarkMetricEvidence {
  indexTimePerFile: number;
  indexTimePerSymbol: number;
  symbolsPerFile: number;
  edgesPerSymbol: number;
  graphConnectivity: number;
  exportedSymbolRatio: number;
  sliceBuildTimeMs: number;
  avgSkeletonTimeMs: number;
  avgCardTokens: number;
  avgSkeletonTokens: number;
  functionMethodRatio: number;
  avgDepsPerSymbol: number;
  callEdgeCount: number;
  importEdgeCount: number;
  totalSymbols: number;
  totalFiles: number;
  summaryGenerationMs: number;
  summaryTokens: number;
  healthScore: number | null;
  watcherEventsProcessed: number;
  watcherErrors: number;
}

export interface ExternalBenchmarkThresholdEvidence {
  metricName: string;
  category: string;
  currentValue: number;
  baselineValue: number | null;
  passed: boolean;
  delta: number | null;
  deltaPercent: number | null;
  message: string;
}

export type ExternalBenchmarkFailureBoundary =
  | "preflight-between-repeats"
  | "child-spawn"
  | "child-stream"
  | "child-exit"
  | "raw-result-missing"
  | "raw-result-invalid"
  | "threshold-evidence-invalid"
  | "unexecuted-after-failure";

export interface ExternalBenchmarkRepeatResult {
  repeat: number;
  exitCode: number | null;
  failureBoundary: ExternalBenchmarkFailureBoundary | null;
  durationMs: number;
  benchmarkResultPath: string;
  benchmarkResultSha256: string | null;
  metrics: ExternalBenchmarkMetricEvidence | null;
  thresholds: ExternalBenchmarkThresholdEvidence[];
  passed: boolean;
}

export interface ExternalBenchmarkResults {
  schemaVersion: 1;
  runManifestSha256: string;
  passed: boolean;
  repeats: ExternalBenchmarkRepeatResult[];
}

export interface ExternalBenchmarkPreflightFailure {
  schemaVersion: 1;
  boundary: "post-artifact-pre-manifest";
  message: string;
}
```

The logical child command starts with the exact spec command and appends stable arguments:

```json
[
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
  "raw/repeat-001.benchmark.json"
]
```

The runner resolves `dist/cli/index.js`, `scripts/external-benchmark-runner.mjs`, and the threshold source `config/benchmark.config.json` against the canonical SDL-MCP root. It resolves staged `inputs/threshold.json`, `inputs/baseline.json`, and `raw/repeat-001.benchmark.json` against the canonical artifact root and passes absolute paths only to the child process. Absolute paths never enter `run-manifest.json`.

### Stable serialization and fingerprint algorithm

Implement these rules literally:

1. Normalize every recorded path by replacing backslashes with forward slashes.
2. Reject an empty path, an absolute recorded path, or any path whose normalized segments contain `..`.
3. Sort path arrays with a code-unit comparator: `a < b ? -1 : a > b ? 1 : 0`. Do not use `localeCompare` because locale can change ordering.
4. Sort repeats numerically. Sort `initialDbFiles` by `destinationPath` then `sourcePath`. Sort warm snapshot and tree entries by `path`.
5. Construct every serialized object with the property order declared above.
6. Serialize with `JSON.stringify(value, null, 2) + "\n"`.
7. Hash the UTF-8 bytes actually written, including the final `\n`.
8. A file hash is SHA-256 over its raw bytes.
9. A tree fingerprint is SHA-256 over compact UTF-8 `JSON.stringify` of the sorted `[{ path, sha256 }]` array. Entry key order is always `path` then `sha256`.
10. The `dist/` tree includes every regular file recursively and rejects symbolic links or special files. Paths are relative to `dist/`.
11. The target tree uses the null-delimited result of `git ls-files --cached --others --exclude-standard -z`. It hashes regular files by bytes and symbolic links by their link text; a missing tracked path is a preflight failure.
12. `sourceDirty` and `sdlMcpSourceDirty` come from non-empty `git status --porcelain=v1 --untracked-files=all` output.
13. Commits come from `git rev-parse HEAD`. The target ref resolves with `git rev-parse --verify lockRef^{commit}` and must equal target `HEAD`.
14. Existing checkout, runner, artifact-parent, config, baseline, threshold, warm-source, and DB-parent roots are canonicalized with `realpathSync.native`. For an absent final file, canonicalize its existing parent and append only the basename. Containment and equality use a platform-aware comparator (case-insensitive only on Windows), never lexical `path.relative` alone.
15. `results.json` preserves repeat order and sorts threshold entries by `metricName`, then `category`. It references the manifest byte hash; it does not hash a re-parsed manifest object.
16. The staged threshold bytes, original threshold bytes, launcher bytes, generated config, baseline, raw child result, and every declared artifact are SHA-256 verified at their named boundaries.

### Task 1: Pin the external target and baseline

**Files:**
- Modify: `tests/unit/setup-external-benchmark-repos.test.ts`
- Modify: `scripts/setup-external-benchmark-repos.ts`
- Modify: `scripts/benchmark/matrix-external-repos.lock.json`
- Modify: `benchmarks/real-world/external-repos.config.json`
- Create: `.benchmark/baseline.scip-io.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing lock/config test**

Replace the hard-coded four-repo assertions with exact five-repo and `scip-io` assertions:

```typescript
const specs = loadExternalRepoSpecs();
assert.deepStrictEqual(
  specs.map((spec) => spec.repoId).sort(),
  ["ansible-lint-oss", "flask-oss", "preact-oss", "scip-io", "zod-oss"],
);

const scipIo = specs.find((spec) => spec.repoId === "scip-io");
assert.deepStrictEqual(scipIo, {
  repoId: "scip-io",
  cloneUrl: "https://github.com/GlitterKill/scip-io.git",
  ref: "2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd",
  languages: ["rs", "ts"],
  ignore: [
    "**/node_modules/**",
    "**/dist/**",
    "**/target/**",
    "**/coverage/**",
  ],
});

const payload = buildExternalRepoConfig(".tmp/external-benchmarks", specs);
assert.strictEqual(payload.repos.length, 5);
assert.strictEqual(
  payload.repos.find((repo) => repo.repoId === "scip-io")?.rootPath,
  ".tmp/external-benchmarks/scip-io",
);
assert.ok(payload.repos.every((repo) => !/^[A-Za-z]:\//.test(repo.rootPath)));
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `node --experimental-strip-types --test tests/unit/setup-external-benchmark-repos.test.ts`

Expected: FAIL because `scip-io` is absent, the repo count is four, and the exact `scip-io` config entry is undefined.

- [ ] **Step 3: Make setup output stable and add the exact lock entry**

Import `relative` from `node:path`'s existing style-equivalent `path` import and change only the config-generation input in `main()`:

```typescript
const configBaseDir = relative(process.cwd(), baseDir) || ".";
const config = buildExternalRepoConfig(configBaseDir, specs);
```

Add this exact object to `scripts/benchmark/matrix-external-repos.lock.json` and the corresponding relative-root object to `benchmarks/real-world/external-repos.config.json`:

```json
{
  "repoId": "scip-io",
  "cloneUrl": "https://github.com/GlitterKill/scip-io.git",
  "ref": "2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd",
  "languages": ["rs", "ts"],
  "ignore": [
    "**/node_modules/**",
    "**/dist/**",
    "**/target/**",
    "**/coverage/**"
  ]
}
```

- [ ] **Step 4: Add the target-specific baseline without changing thresholds**

Create `.benchmark/baseline.scip-io.json` from the persisted 2026-07-07 `scip-io` measurement. Keep only the format, target, and ten metrics consumed by `loadBaselineMetrics`:

```json
{
  "formatVersion": 1,
  "repoId": "scip-io",
  "metrics": {
    "indexTimePerFile": 311.5638318181818,
    "indexTimePerSymbol": 10.534432838114753,
    "symbolsPerFile": 29.575757575757574,
    "edgesPerSymbol": 0.5527663934426229,
    "graphConnectivity": 0.2459016393442623,
    "exportedSymbolRatio": 0.992827868852459,
    "sliceBuildTimeMs": 465.69450000001234,
    "avgSkeletonTimeMs": 4.416600000001684,
    "avgCardTokens": 175.25,
    "avgSkeletonTokens": 2
  }
}
```

Add exactly `!.benchmark/baseline.scip-io.json` beside the other baseline exceptions in `.gitignore`. Do not edit either benchmark threshold config.

- [ ] **Step 5: Run the focused tests and verify green**

Run: `node --experimental-strip-types --test tests/unit/setup-external-benchmark-repos.test.ts tests/unit/benchmark-baseline-repo.test.ts`

Expected: PASS. The setup suite reports five pinned repos and the baseline loader suite still rejects a mismatched target.

- [ ] **Step 6: Commit the pinned inputs**

```bash
git add .gitignore .benchmark/baseline.scip-io.json scripts/setup-external-benchmark-repos.ts scripts/benchmark/matrix-external-repos.lock.json benchmarks/real-world/external-repos.config.json tests/unit/setup-external-benchmark-repos.test.ts
git diff --cached --check
git commit -m "test: pin scip-io benchmark inputs"
```

Expected: the staged diff contains no threshold changes.

### Task 2: Add canonical manifest and result evidence

The checklist below is the authoritative execution order; the later numbered steps are code/reference details, not permission to batch slices.

- [ ] **Slice A test:** Add only serialization, key-order, path, launcher, threshold, and exact-byte hash assertions.
- [ ] **Slice A red:** Run `npm run build:runtime`, then `node --test --test-name-pattern="serializes|sorts warm|hashes the exact" tests/unit/external-benchmark-manifest.test.ts`; require the named assertions to fail.
- [ ] **Slice A implement:** Implement only fixed-order normalization/serialization and exact manifest-byte hashing from Step 3.
- [ ] **Slice A green:** Rebuild and rerun the exact Slice A command; require pass before adding Slice B tests.
- [ ] **Slice B test:** Add only file-tree, build-tree, target-tree, launcher-byte, and mutation fingerprint assertions.
- [ ] **Slice B red:** Run `npm run build:runtime`, then `node --test --test-name-pattern="fingerprint|launcher" tests/unit/external-benchmark-manifest.test.ts`; require failure.
- [ ] **Slice B implement:** Implement only raw-byte file/tree/launcher fingerprints from Step 4.
- [ ] **Slice B green:** Rebuild and rerun the exact Slice B command; require pass before adding Slice C tests.
- [ ] **Slice C test:** Add only result ordering, exact repeat count, real failure boundary, synthesized later repeats, and strict pass assertions.
- [ ] **Slice C red:** Run `npm run build:runtime`, then `node --test --test-name-pattern="threshold evidence|partial run|failure boundary" tests/unit/external-benchmark-manifest.test.ts`; require failure.
- [ ] **Slice C implement:** Implement only complete-count result normalization and stable failure-boundary serialization from Step 5.
- [ ] **Slice C green:** Rebuild, rerun the exact Slice C command, then run the unfiltered manifest test; all must pass.

**Files:**
- Create: `tests/unit/external-benchmark-manifest.test.ts`
- Create: `src/benchmark/external-manifest.ts`

- [ ] **Step 1: Write failing stable-manifest tests**

The block below is the completed reference fixture. Add only the Slice A assertions first; append the fingerprint test in Slice B and the result tests in Slice C, running red and green between slices:

```typescript
it("serializes identical manifest inputs to identical bytes", () => {
  const first = serializeRunManifest(makeManifest());
  const second = serializeRunManifest(makeManifest());
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.ok(first.indexOf('"schemaVersion"') < first.indexOf('"target"'));
  assert.ok(first.indexOf('"target"') < first.indexOf('"runner"'));
  assert.ok(first.indexOf('"runner"') < first.indexOf('"inputs"'));
  assert.ok(first.indexOf('"inputs"') < first.lastIndexOf('"repeats"'));
  assert.doesNotMatch(first, /[A-Za-z]:\\\\|F:\//);
});

it("sorts warm files, initial files, and repeats before serialization", () => {
  const parsed = JSON.parse(serializeRunManifest(makeUnsortedWarmManifest()));
  assert.deepStrictEqual(
    parsed.inputs.warmSnapshot.files.map((file: HashedArtifactFile) => file.path),
    [
      "inputs/warm-db/repository.lbug",
      "inputs/warm-db/repository.lbug.wal",
    ],
  );
  assert.deepStrictEqual(parsed.repeats.map((repeat: { repeat: number }) => repeat.repeat), [1, 2]);
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
});

it("changes the dist fingerprint when one built file changes", () => {
  writeFileSync(join(distRoot, "a.js"), "one");
  writeFileSync(join(distRoot, "nested", "b.js"), "two");
  const first = fingerprintDirectory(distRoot);
  writeFileSync(join(distRoot, "nested", "b.js"), "changed");
  const second = fingerprintDirectory(distRoot);
  assert.notEqual(first.sha256, second.sha256);
  assert.deepStrictEqual(first.files.map((file) => file.path), ["a.js", "nested/b.js"]);
});

it("sorts threshold evidence and references the manifest hash", () => {
  const results = buildExternalBenchmarkResults(
    "a".repeat(64),
    1,
    [makeRawRepeatWithThresholdOrder(["sliceBuildTimeMs", "edgesPerSymbol"])],
  );
  assert.equal(results.runManifestSha256, "a".repeat(64));
  assert.deepStrictEqual(
    results.repeats[0].thresholds.map((entry) => entry.metricName),
    ["edgesPerSymbol", "sliceBuildTimeMs"],
  );
});

it("synthesizes every missing repeat and cannot pass a partial run", () => {
  const results = buildExternalBenchmarkResults(
    "a".repeat(64),
    3,
    [makePassingRawRepeat(1)],
    { boundary: "preflight-between-repeats", failedRepeat: 2 },
  );
  assert.equal(results.passed, false);
  assert.equal(results.repeats.length, 3);
  assert.equal(results.repeats[1]?.repeat, 2);
  assert.equal(results.repeats[1]?.failureBoundary, "preflight-between-repeats");
  assert.equal(results.repeats[1]?.benchmarkResultSha256, null);
  assert.equal(results.repeats[2]?.repeat, 3);
  assert.equal(results.repeats[2]?.failureBoundary, "unexecuted-after-failure");
});
```

Define `makeManifest` and `makeUnsortedWarmManifest` in the test with all contract fields populated by fixed strings. Use hashes such as `"a".repeat(64)`; do not use dates, random values, or current platform values in this byte-stability fixture.

- [ ] **Step 2: Build and verify the red state**

Run: `npm run build:runtime`

Then run: `node --test tests/unit/external-benchmark-manifest.test.ts`

Expected: FAIL because `dist/benchmark/external-manifest.js` does not exist.

- [ ] **Step 3: Implement fixed-order serialization**

Implement `compareArtifactPath`, `normalizeArtifactPath`, `serializeRunManifest`, `hashSerializedManifest`, and `serializeExternalBenchmarkResults`. Construct a fresh normalized object instead of serializing the caller's object directly:

```typescript
export function compareArtifactPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function serializeRunManifest(
  input: ExternalBenchmarkRunManifest,
): string {
  const warmSnapshot =
    input.inputs.warmSnapshot === null
      ? null
      : {
          files: [...input.inputs.warmSnapshot.files]
            .map(normalizeHashedFile)
            .sort((a, b) => compareArtifactPath(a.path, b.path)),
        };

  const repeats = [...input.repeats]
    .map((repeat) => ({
      repeat: repeat.repeat,
      graphDbPath: normalizeArtifactPath(repeat.graphDbPath),
      stdoutPath: normalizeArtifactPath(repeat.stdoutPath),
      stderrPath: normalizeArtifactPath(repeat.stderrPath),
      initialDbFiles: [...repeat.initialDbFiles]
        .map(normalizeInitialDbFile)
        .sort(
          (a, b) =>
            compareArtifactPath(a.destinationPath, b.destinationPath) ||
            compareArtifactPath(a.sourcePath, b.sourcePath),
        ),
      command: [...repeat.command],
    }))
    .sort((a, b) => a.repeat - b.repeat);

  const manifest: ExternalBenchmarkRunManifest = {
    schemaVersion: 1,
    target: {
      repoId: input.target.repoId,
      sourceRef: input.target.sourceRef,
      sourceCommit: input.target.sourceCommit,
      sourceDirty: input.target.sourceDirty,
      sourceTreeSha256: input.target.sourceTreeSha256,
      scipArtifactPath:
        input.target.scipArtifactPath === null
          ? null
          : normalizeArtifactPath(input.target.scipArtifactPath),
      scipArtifactSha256: input.target.scipArtifactSha256,
    },
    runner: {
      sdlMcpVersion: input.runner.sdlMcpVersion,
      sdlMcpCommit: input.runner.sdlMcpCommit,
      sdlMcpSourceDirty: input.runner.sdlMcpSourceDirty,
      sdlMcpBuildTreeSha256: input.runner.sdlMcpBuildTreeSha256,
      launcherPath: "scripts/external-benchmark-runner.mjs",
      launcherSha256: input.runner.launcherSha256,
      nodeVersion: input.runner.nodeVersion,
      platform: input.runner.platform,
      architecture: input.runner.architecture,
      cacheMode: input.runner.cacheMode,
      repeats: input.runner.repeats,
    },
    inputs: {
      configPath: "inputs/sdlmcp.config.json",
      configSha256: input.inputs.configSha256,
      baselinePath: "inputs/baseline.json",
      baselineSha256: input.inputs.baselineSha256,
      baselineFormatVersion: "1",
      baselineTargetRepoId: input.inputs.baselineTargetRepoId,
      thresholdSourcePath: "config/benchmark.config.json",
      thresholdPath: "inputs/threshold.json",
      thresholdSha256: input.inputs.thresholdSha256,
      warmSnapshot,
    },
    repeats,
  };

  return JSON.stringify(manifest, null, 2) + "\n";
}

export function hashSerializedManifest(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
```

`normalizeArtifactPath` must reject absolute paths, empty paths, `.`, and `..` segments after slash normalization. `normalizeHashedFile` and `normalizeInitialDbFile` construct new objects with the declared key order and validate 64-character lowercase hexadecimal hashes.

- [ ] **Step 4: Implement raw-byte file and tree fingerprints**

Use the standard library only:

```typescript
export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function fingerprintFiles(
  rootPath: string,
  relativePaths: readonly string[],
): { files: HashedArtifactFile[]; sha256: string } {
  const files = relativePaths
    .map((relativePath) => {
      const path = normalizeArtifactPath(relativePath);
      const absolutePath = resolve(rootPath, ...path.split("/"));
      const stats = lstatSync(absolutePath);
      const sha256 = stats.isSymbolicLink()
        ? createHash("sha256")
            .update(readlinkSync(absolutePath), "utf8")
            .digest("hex")
        : stats.isFile()
          ? sha256File(absolutePath)
          : (() => {
              throw new Error("Fingerprint input is not a file: " + path);
            })();
      return { path, sha256 };
    })
    .sort((a, b) => compareArtifactPath(a.path, b.path));

  const sha256 = createHash("sha256")
    .update(JSON.stringify(files), "utf8")
    .digest("hex");
  return { files, sha256 };
}
```

Implement `fingerprintDirectory` with a recursive, sorted `readdirSync(..., { withFileTypes: true })` walk and delegate to `fingerprintFiles`. Reject symbolic links for `dist/` before delegation; `fingerprintFiles` retains link-text support for the Git worktree fingerprint.

- [ ] **Step 5: Implement fixed-order results normalization**

Map the raw `benchmark:ci` result into `ExternalBenchmarkMetricEvidence` in the exact interface order. Map threshold entries into the declared evidence order, replace absent optional numbers with `null`, sort by metric name/category, sort repeats numerically, and accept `expectedRepeats` plus an optional stable stop boundary. Create the first non-executed or structurally failed repeat with the real stop boundary supplied by orchestration; synthesize `unexecuted-after-failure` only for higher repeat numbers. The result always contains exactly the manifest count. Set:

```typescript
const passed =
  repeats.length === expectedRepeats &&
  expectedRepeats > 0 &&
  repeats.every(
    (repeat) =>
      repeat.exitCode === 0 &&
      repeat.failureBoundary === null &&
      repeat.benchmarkResultSha256 !== null &&
      repeat.metrics !== null &&
      repeat.thresholds.length > 0 &&
      repeat.thresholds.every((threshold) => threshold.passed),
  );
```

`serializeExternalBenchmarkResults` uses `JSON.stringify(results, null, 2) + "\n"` and constructs each repeat with `failureBoundary` immediately after `exitCode`. Do not copy `timestamp`, `repoPath`, absolute config paths, or `lockedRepos` from the raw child result.

- [ ] **Step 6: Build and verify the manifest tests are green**

Run: `npm run build:runtime`

Then run: `node --test tests/unit/external-benchmark-manifest.test.ts`

Expected: PASS for byte identity, ordering, exact-byte hashing, tree mutation, and sorted threshold evidence.

- [ ] **Step 7: Commit the canonical evidence model**

```bash
git diff --cached --name-only
git add src/benchmark/external-manifest.ts tests/unit/external-benchmark-manifest.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: add canonical external benchmark manifests"
```

## Chunk 2: Database Isolation and Runner Preflight

### Task 3: Implement cold/warm database isolation and preflight validation

The checklist below is the authoritative execution order; add no later-slice test before the current slice is green.

- [ ] **Slice A test:** Add DB-family enumeration/absence/fingerprint and membership-change cases.
- [ ] **Slice A red:** Build, then run `node --test --test-name-pattern="database family|fingerprint" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice A implement:** Implement only family enumeration, absence, and sorted fingerprint helpers.
- [ ] **Slice A green:** Rebuild and rerun the exact Slice A command; require pass.
- [ ] **Slice B test:** Add cold-repeat exclusivity, distinct repeat path, and no-delete cases.
- [ ] **Slice B red:** Build, then run `node --test --test-name-pattern="cold" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice B implement:** Implement only cold repeat preparation.
- [ ] **Slice B green:** Rebuild and rerun the exact Slice B command; require pass.
- [ ] **Slice C test:** Add warm source before/after stability, exclusive staging, copy hash, and changed-sidecar cases.
- [ ] **Slice C red:** Build, then run `node --test --test-name-pattern="warm" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice C implement:** Implement only warm snapshot/repeat preparation.
- [ ] **Slice C green:** Rebuild and rerun the exact Slice C command; require pass.
- [ ] **Slice D test:** Add canonical realpath/junction, environment sanitization, target/config/baseline/threshold/launcher mismatch cases.
- [ ] **Slice D red:** Build, then run `node --test --test-name-pattern="environment|canonical|threshold|launcher|target" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice D implement:** Implement only canonical preflight and strict input/environment validators.
- [ ] **Slice D green:** Rebuild, rerun the exact Slice D command, then run the unfiltered runner test; all must pass.

**Files:**
- Create: `tests/unit/external-benchmark-runner.test.ts`
- Create: `src/benchmark/external-runner.ts`

- [ ] **Step 1: Write failing database-family tests**

The numbered cases are the completed reference set. Introduce only the family/fingerprint cases in Slice A, cold cases in Slice B, and warm cases in Slice C, with a red-green run between each:

1. `collectDbFamilyFiles("repository.lbug")` returns the primary, `.wal`, `.wal.checkpoint`, and a future `.metadata` sidecar sorted by path; it ignores `repository.lbug-other` and unrelated files.
2. `prepareColdRepeat` returns `initialDbFiles: []` when the entire destination family is absent.
3. `prepareColdRepeat` throws before deletion when the primary, `.wal`, `.wal.checkpoint`, or any `basename + "."` sidecar exists.
4. `stageWarmSnapshot` copies the source family to `inputs/warm-db/repository.lbug*` with `COPYFILE_EXCL` and returns sorted hashes.
5. `prepareWarmRepeat` copies each staged input to `db/repeat-001.lbug*`, records `sourcePath`, `destinationPath`, and `sha256`, and verifies the destination hash.
6. A second repeat uses `db/repeat-002.lbug*` and shares no destination path with repeat 1.
7. An existing warm destination or a changed staged-input hash throws without invoking `rmSync` or overwriting a byte.
8. `stageWarmSnapshot` fingerprints the complete source family before and after copying; added/removed sidecars or changed bytes during the copy reject the snapshot and preserve the copied evidence without cleanup.
9. `fingerprintDbFamily` includes sorted family-relative names and raw-byte hashes, so membership and content changes are independently visible.

Use an `fs.rmSync` spy only to assert it is never called by production helpers. Test cleanup may remove the test's own `mkdtempSync` directory in `afterEach`.

- [ ] **Step 2: Write failing input/environment tests**

Add cases that assert a child is not invoked when:

- a positive inherited-environment case starts with `SDL_GRAPH_DB_DIR` plus conflicting DB/config variables and proves `buildChildEnvironment` removes all four before invoking the child; a separate direct `assertChildEnvironment` case rejects `SDL_GRAPH_DB_DIR` only when it survives or is reintroduced after sanitization;
- `SDL_CONFIG` is absent or does not canonicalize to `inputs/sdlmcp.config.json`;
- `SDL_GRAPH_DB_PATH` is absent, escapes the canonical artifact root through a junction or symlink, differs from the repeat manifest, or repeats a prior platform-normalized path;
- the baseline has no `formatVersion: 1`, has another `repoId`, omits one of the ten required metrics, or contains a non-finite metric;
- the threshold source is malformed JSON, has `version !== "1.0"`, has empty thresholds, omits any of the ten evaluated category/metric pairs, contains a non-finite numeric limit, or differs byte-for-byte from `inputs/threshold.json`;
- the launcher hash, staged threshold hash, or canonical target/config/baseline path differs from the manifest;
- the generated config does not contain exactly the selected target or its root path resolves to another checkout;
- target `HEAD` differs from the locked ref;
- target or runner commit, dirty state, source-tree hash, or `dist/` hash differs from the manifest snapshot.

Inject a `runChild` spy and assert `callCount === 0` for every preflight failure.

- [ ] **Step 3: Build and verify the red state**

Run: `npm run build:runtime`

Then run: `node --test tests/unit/external-benchmark-runner.test.ts`

Expected: FAIL because `dist/benchmark/external-runner.js` does not exist.

- [ ] **Step 4: Implement database family enumeration without deletion**

Use a dedicated parent directory per repeat and treat the exact basename plus every `basename + "."` regular file as one LadybugDB family:

```typescript
export function collectDbFamilyFiles(primaryPath: string): string[] {
  const directory = dirname(primaryPath);
  const basename = basename(primaryPath);
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === basename || entry.name.startsWith(basename + ".")),
    )
    .map((entry) => join(directory, entry.name))
    .sort((a, b) =>
      compareArtifactPath(normalizeSlashes(a), normalizeSlashes(b)),
    );
}

export function assertDbFamilyAbsent(primaryPath: string): void {
  const existing = collectDbFamilyFiles(primaryPath);
  if (existing.length > 0) {
    throw new Error(
      "Database family must be absent: " +
        existing.map(normalizeSlashes).join(", "),
    );
  }
}
```

This catches the known `.wal` and `.wal.checkpoint` files and future LadybugDB sidecars without maintaining a suffix allowlist. Add `fingerprintDbFamily(primaryPath)` on top of this enumeration; it returns sorted `{ path: basename-relative-name, sha256 }` entries plus the compact-list hash. It rejects non-regular family entries and is reused for warm-source before/after comparison and the default-project-DB closeout proof.

- [ ] **Step 5: Implement exact cold and warm preparation**

`prepareColdRepeat` builds `db/repeat-NNN.lbug`, calls `assertDbFamilyAbsent`, and returns an empty `initialDbFiles` array.

`stageWarmSnapshot` requires a present primary and a quiescent source family. Fingerprint its complete membership and bytes, create a previously absent `inputs/warm-db` directory, map the source primary basename to `repository.lbug` while preserving each suffix, copy with `copyFileSync(source, destination, COPYFILE_EXCL)`, hash the copies, then fingerprint the source family again. Require exact before/after membership and hashes before accepting the staged snapshot; never delete partial evidence after a mismatch.

`prepareWarmRepeat`:

1. Calls `assertDbFamilyAbsent` for the repeat destination.
2. Re-hashes every staged input and compares it with the manifest snapshot.
3. Maps `inputs/warm-db/repository.lbug` plus suffixes to `db/repeat-NNN.lbug` plus the same suffixes.
4. Copies with `COPYFILE_EXCL`.
5. Re-hashes each destination and requires equality with its source hash.
6. Returns sorted `InitialDbFile` entries.
7. Never exposes `inputs/warm-db` to the child as a database path.

- [ ] **Step 6: Implement target, runner, baseline, config, and environment validation**

Add these focused helpers and keep them pure where possible:

```typescript
export interface GitSnapshot {
  commit: string;
  dirty: boolean;
  treeSha256: string;
}

export interface BaselineV1 {
  formatVersion: 1;
  repoId: string;
  metrics: Pick<
    ExternalBenchmarkMetricEvidence,
    | "indexTimePerFile"
    | "indexTimePerSymbol"
    | "symbolsPerFile"
    | "edgesPerSymbol"
    | "graphConnectivity"
    | "exportedSymbolRatio"
    | "sliceBuildTimeMs"
    | "avgSkeletonTimeMs"
    | "avgCardTokens"
    | "avgSkeletonTokens"
  >;
}

export function assertChildEnvironment(
  env: NodeJS.ProcessEnv,
  artifactRoot: string,
  manifest: ExternalBenchmarkRunManifest,
  repeat: ExternalBenchmarkRepeatManifest,
  usedDbPaths: Set<string>,
): void;
```

`readGitSnapshot` runs these exact Git commands with `execFileSync` argument arrays, never shell interpolation:

- `git -C snapshotRoot rev-parse HEAD`
- `git -C snapshotRoot status --porcelain=v1 --untracked-files=all`
- `git -C snapshotRoot ls-files --cached --others --exclude-standard -z`

`assertTargetRef` additionally resolves the lock ref with `git -C targetRoot rev-parse --verify lockRef^{commit}` and requires the target's `origin` URL to equal the lock `cloneUrl` after trimming a trailing slash.

`validateBaselineV1` requires numeric `formatVersion === 1`, exact target `repoId`, every required metric, and `Number.isFinite` for each metric. Add `validateThresholdConfigV1` for the current `version: "1.0"` shape. It requires non-empty `thresholds` and the ten evaluated pairs under `indexing`, `quality`, `performance`, and `tokenEfficiency`; each rule must have the expected trend plus finite absolute and allowable values. It returns the sorted expected category/metric pairs for raw-result validation.

`buildGeneratedRunConfig` reads `config/sdlmcp.config.json` and `benchmarks/real-world/external-repos.config.json`, selects exactly one target entry, replaces `repos` with that entry, and sets `indexing.enableFileWatching` to `false` while preserving the remaining base settings. `validateGeneratedRunConfig` canonicalizes both the selected existing root and pinned checkout with `realpathSync.native` and requires platform-aware equality.

`buildChildEnvironment` starts from the inherited environment but explicitly deletes `SDL_GRAPH_DB_DIR`, `SDL_GRAPH_DB_PATH`, `SDL_DB_PATH`, and `SDL_CONFIG` before assigning the exact manifest values. `assertChildEnvironment` rejects any remaining `SDL_GRAPH_DB_DIR`, canonicalizes the existing config and artifact root with `realpathSync.native`, canonicalizes the DB path by realpathing its existing parent and appending only the absent basename, requires platform-aware containment and equality with the repeat manifest, rejects normalized reuse on Windows, and requires `SDL_DB_PATH === SDL_GRAPH_DB_PATH`. Add real symlink or junction escape tests where the platform permits creation; skip only on an explicit permission error.

- [ ] **Step 7: Build and verify isolation tests are green**

Run: `npm run build:runtime`

Then run: `node --test tests/unit/external-benchmark-runner.test.ts`

Expected: PASS. Cold state is never deleted, warm copies are exclusive and hash-verified, all paths are repeat-scoped, and every mismatch prevents child execution.

- [ ] **Step 8: Commit the isolation boundary**

```bash
git diff --cached --name-only
git add src/benchmark/external-runner.ts tests/unit/external-benchmark-runner.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: isolate external benchmark databases"
```

### Task 4: Orchestrate the child run and persist evidence

The checklist below is the authoritative execution order; the later orchestration steps are reference details.

- [ ] **Slice A test:** Add CLI parsing, canonical absent-root, already-existing-root, and post-root/pre-manifest failure artifact cases.
- [ ] **Slice A red:** Build, then run `node --test --test-name-pattern="CLI|artifact root|preflight" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice A implement:** Implement only CLI parsing, canonical root creation, preflight log, and pre-manifest failure persistence.
- [ ] **Slice A green:** Rebuild and rerun the exact Slice A command; require pass.
- [ ] **Slice B test:** Add exclusive staged inputs/raw-output flag, manifest/input/launcher/threshold hashes, and per-child revalidation cases.
- [ ] **Slice B red:** Build, run the exclusive-output test, then run `node --test --test-name-pattern="manifest|staged input|launcher|threshold" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice B implement:** Implement the exclusive writer/child flag and only manifest construction plus input revalidation.
- [ ] **Slice B green:** Rebuild, run `node --test tests/unit/external-benchmark-output.test.ts`, and rerun the exact Slice B runner command; require pass.
- [ ] **Slice C test:** Add rejected child, spawn/stream, between-repeat, parse, real-boundary, and complete-count failure cases.
- [ ] **Slice C red:** Build, then run `node --test --test-name-pattern="spawn|stream|between-repeat|repeat count" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice C implement:** Implement only child execution plus post-manifest catch/finally result persistence.
- [ ] **Slice C green:** Rebuild and rerun the exact Slice C command; require pass.
- [ ] **Slice D test:** Add exact raw threshold set, result hash, verifier, optional SCIP, default-DB, and package-script cases.
- [ ] **Slice D red:** Build, then run `node --test --test-name-pattern="thresholdResult|verifier|package|SCIP|default DB" tests/unit/external-benchmark-runner.test.ts`; require failure.
- [ ] **Slice D implement:** Implement only strict raw normalization, executable verifier/default-DB comparison, thin adapters, and package entries.
- [ ] **Slice D green:** Rebuild, rerun the exact Slice D command, then run both unfiltered benchmark test files; all must pass.

**Files:**
- Create: `tests/unit/external-benchmark-output.test.ts`
- Create: `src/benchmark/output-file.ts`
- Modify: `src/cli/commands/benchmark.ts`
- Modify: `tests/unit/external-benchmark-runner.test.ts`
- Modify: `src/benchmark/external-runner.ts`
- Create: `scripts/external-benchmark-runner.mjs`
- Create: `scripts/verify-external-benchmark-evidence.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing orchestration tests with a fake child**

Add a test-only `runChild` implementation that writes a valid raw result to the requested `raw/repeat-NNN.benchmark.json` and returns a controlled exit code/duration. The bullets below are the completed reference set; introduce only the bullets owned by the current Slice A–D and run red-green before proceeding. Prove:

- the artifact root must be absent at start;
- `repeats: 2` creates stable `repeat-001` and `repeat-002` DB/log/raw-result names;
- the manifest is written before the first child call;
- the child receives exact `SDL_CONFIG`, `SDL_GRAPH_DB_PATH`, and `SDL_DB_PATH` values;
- stdout and stderr paths match the manifest;
- the child command starts with `node dist/cli/index.js benchmark:ci`, includes `--out-exclusive` exactly once, and contains the selected target, baseline, unchanged staged threshold, and raw output paths;
- `preflight-error.json` is written with `flag: "wx"` for failures after artifact-root creation but before the manifest, while an already-existing output root fails before any write;
- `results.json` exists even when the fake child returns exit 1 for a threshold failure, rejects overwrite, and contains exactly the requested repeat count;
- a threshold failure produces `passed: false` without editing either threshold file;
- malformed or missing raw child output produces `metrics: null`, `benchmarkResultSha256: null`, a stable failure boundary, and a failed repeat;
- an absent, empty, duplicated, or inconsistent raw `thresholdResult.evaluations` set is `threshold-evidence-invalid`, even when the child exits 0;
- rejected `runChild`, spawn error, stdout/stderr stream error, parse error, and between-repeat preflight error all persist `results.json` in `finally`, synthesize every unexecuted repeat, and retain declared logs;
- changing target state, runner state, launcher bytes, original or staged threshold bytes, `dist/`, or the warm snapshot between repeats prevents the next child call.

Also read `package.json` and assert both exact entries: `scripts["benchmark:external"] === "node scripts/external-benchmark-runner.mjs"` and `scripts["benchmark:external:verify"] === "node scripts/verify-external-benchmark-evidence.mjs"`.

- [ ] **Step 2: Run the focused test and verify the new red assertions**

Run: `npm run build:runtime`

Then run: `node --test tests/unit/external-benchmark-runner.test.ts`

Expected: FAIL because orchestration, result persistence, and the package entry point are absent.

- [ ] **Step 3: Add exact CLI options and defaults**

`runExternalBenchmarkCli` accepts:

| Option | Default | Validation |
| --- | --- | --- |
| `--repo-id` | Required | Must appear exactly once in the external lock and generated config. |
| `--out-dir` | Required | Resolved path must not exist. The runner creates it and never removes it. |
| `--lock` | `scripts/benchmark/matrix-external-repos.lock.json` | Must parse to a non-empty repo list. |
| `--base-config` | `config/sdlmcp.config.json` | Must parse and produce one selected repo. |
| `--external-config` | `benchmarks/real-world/external-repos.config.json` | Selected root must equal the pinned checkout. |
| `--baseline` | `".benchmark/baseline." + repoId + ".json"` | Must pass `BaselineV1` validation for the target. |
| `--threshold` | `config/benchmark.config.json` | Source must pass strict v1 validation; the runner copies it exclusively to `inputs/threshold.json`, hashes both, and never writes the source. |
| `--cache-mode` | `cold` | Exactly `cold` or `warm`. |
| `--repeats` | `1` | Integer from 1 through 20. |
| `--warm-db` | None | Required only for warm mode and forbidden for cold mode. |
| `--scip-artifact` | None | If present, must resolve inside the target checkout and is hashed; otherwise the manifest stores `null`. |

Reject unknown flags and missing values. Do not add a force, overwrite, cleanup, random-name, or threshold-update flag.

- [ ] **Step 4: Build the manifest before child execution**

The orchestration order is fixed:

1. Canonicalize the SDL-MCP root and existing output parent, require the named output root to be absent, create that root exclusively, and open an exclusive preflight log. An already-existing root fails before any write.
2. Inside a pre-manifest `try/catch`, require built `dist/cli/index.js`; parse the lock; select and canonicalize the target; validate remote/ref/commit/tree state.
3. Read package version, runner commit/dirty state, complete `dist/` fingerprint, and raw launcher hash.
4. Strictly parse the baseline and threshold source; compute their raw-byte hashes.
5. Create previously absent `inputs`, `logs`, `db`, and `raw` directories.
6. Write the generated config, exact baseline copy, and exact `inputs/threshold.json` copy with exclusive creation; re-hash every staged input.
7. Stage the warm snapshot when requested, proving source-family stability.
8. Prepare every repeat's absent database family and stable paths.
9. Construct `ExternalBenchmarkRunManifest` and write its exact serialized bytes to `run-manifest.json` with `flag: "wx"`.
10. Hash those written bytes for later `results.json` use. If any step after root creation and before Step 9 fails, write stable `preflight-error.json` with `flag: "wx"`, preserve the preflight log, return 1, and do not invent `results.json`.

Use `writeFileSync(path, bytes, { encoding: "utf8", flag: "wx" })` for every JSON setup/evidence file. Open stdout and stderr with exclusive `wx` streams. Never truncate a raced path.

- [ ] **Exclusive-output test:** Create `tests/unit/external-benchmark-output.test.ts` proving overwrite mode replaces an existing fixture, exclusive mode creates an absent fixture, and exclusive mode throws without changing pre-existing bytes.
- [ ] **Exclusive-output red:** Run `npm run build:runtime`, then `node --test tests/unit/external-benchmark-output.test.ts`; require failure because the helper/flag do not exist.
- [ ] **Exclusive-output implementation:** Add `writeUtf8Output(path, bytes, mode)` in `src/benchmark/output-file.ts` with only `"overwrite"` -> `w` and `"exclusive"` -> `wx`. Parse an internal `--out-exclusive` boolean in `benchmarkCICommand`, keep the default overwrite mode unchanged, and route the final raw JSON write through the helper. Use exclusive mode for every wrapper evidence write.
- [ ] **Exclusive-output green:** Rebuild and rerun the exact output test, run `node dist/cli/index.js benchmark:ci --help` and require one `--out-exclusive` option, then assert the wrapper child command includes that flag once. All checks must pass before child orchestration work continues.

- [ ] **Step 5: Execute repeats with streams and revalidation**

Define one justified test seam:

```typescript
export interface BenchmarkChildRequest {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  rawResultPath: string;
}

export type RunBenchmarkChild = (
  request: BenchmarkChildRequest,
) => Promise<{ exitCode: number | null; durationMs: number }>;
```

The production implementation creates stdout and stderr streams with `flags: "wx"`, then uses `spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })`. It handles child `error`, both stream `error` events, child close, and both stream closes without leaving an unobserved rejection. Round `durationMs` to three decimal places. A spawn or stream failure returns a stable failure boundary and never truncates an existing path.

Immediately before each child:

- re-read and compare target commit, dirty state, and tree hash;
- re-read and compare runner commit, dirty state, `dist/` hash, and launcher bytes;
- re-hash the generated config, baseline source/copy, threshold source/copy, and warm snapshot;
- strictly re-parse the threshold source and require the same sorted category/metric contract;
- assert the repeat DB family is still in its declared initial state;
- compose the child environment after deleting inherited SDL DB/config variables, validate canonical paths, and assert `SDL_GRAPH_DB_DIR` is absent;
- reserve the canonical platform-normalized graph DB path in the used-path set.

A valid threshold-failure result does not stop later repeats. A preflight state mismatch, rejected child, spawn/stream error, or parse failure stops before the next child, records the stable boundary, and enters the result-writing `finally` block with already completed evidence intact.

- [ ] **Step 6: Normalize and persist results**

After each child, parse only its declared raw result file. Require `repoId` to equal the selected target and validate finite metrics. Require `thresholdResult` to exist, `evaluations` to have exact set equality with the configured category/metric pairs (each expected pair exactly once and no unexpected pair), every value and boolean to be valid, `summary.total/passed/failed` to agree with the evaluations, and `thresholdResult.passed` to equal `evaluations.every(...)`. An empty or missing evaluation array is never a pass.

Wrap the post-manifest repeat loop in `try/catch/finally`. The catch records one stable failure boundary and the first affected repeat; the finally normalizes completed rows, synthesizes every remaining repeat up to `manifest.runner.repeats`, serializes once, and creates `results.json` with `flag: "wx"`. The CLI returns 0 only when the complete `ExternalBenchmarkResults.passed` is true. It returns 1 for validation errors, child crashes, malformed evidence, missing repeats, or any threshold failure. Error messages go to stderr and declared logs; no error path substitutes the default DB or rewrites a threshold.

- [ ] **Step 7: Add thin runner and evidence-verifier executables**

Create `scripts/external-benchmark-runner.mjs`:

```javascript
#!/usr/bin/env node

import { runExternalBenchmarkCli } from "../dist/benchmark/external-runner.js";

try {
  process.exitCode = await runExternalBenchmarkCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

Add these exact package entries:

```json
"benchmark:external": "node scripts/external-benchmark-runner.mjs",
"benchmark:external:verify": "node scripts/verify-external-benchmark-evidence.mjs"
```

Create `scripts/verify-external-benchmark-evidence.mjs` as another thin adapter over exported `verifyExternalBenchmarkEvidence`. It accepts required `--root`, `--repo-id`, `--source-ref`, `--source-commit`, `--cache-mode`, `--repeats`, `--default-db-before`, and `--default-db-after` options and sets `process.exitCode` from the verifier. The verifier must execute all of these checks, not print a manual checklist:

1. Recompute the exact manifest-byte hash and match `results.runManifestSha256`; require `results.passed === true`.
2. Match target id/ref/commit, clean target/runner flags, cache mode, repeat count, and cold `warmSnapshot === null` plus empty `initialDbFiles`. Recompute the target Git file-set/tree fingerprint, runner commit/dirty state, complete `dist/` tree fingerprint, and launcher raw-byte hash from their canonical source roots.
3. Reject prohibited keys or values (timestamps, sessions, random ids, machine absolute paths) and require every manifest path to be relative, slash-normalized, and canonically contained in the artifact root.
4. Require every declared config/baseline/threshold/log/raw/DB artifact to exist; re-hash the original threshold source plus staged threshold, all other staged inputs, every raw benchmark result, and—when declared—the canonical target-relative SCIP artifact; match the manifest source hashes and each `benchmarkResultSha256`.
5. Validate every raw result with the strict threshold contract and require each result entry and failure boundary to agree with it.
6. Parse the two default-DB family fingerprint files and require byte-identical sorted membership/hashes.

Also export `writeDbFamilyFingerprintFile(primaryPath, outputPath)` from `external-runner.ts`. It serializes `{ schemaVersion: 1, files, sha256 }` in fixed key order and creates the output with `flag: "wx"`; an absent family is represented by an empty sorted file list and its deterministic list hash.

The verifier prints one success line only after all checks pass and exits 1 on the first named invariant failure.

- [ ] **Step 8: Build and run all focused benchmark tests**

Run: `npm run build:runtime`

Then run:

`node --test tests/unit/external-benchmark-output.test.ts tests/unit/external-benchmark-manifest.test.ts tests/unit/external-benchmark-runner.test.ts tests/unit/real-world-benchmark-matrix.test.ts`

Then run:

`node --experimental-strip-types --test tests/unit/setup-external-benchmark-repos.test.ts tests/unit/benchmark-baseline-repo.test.ts`

Expected: all tests PASS. No test launches `benchmark:ci` or accesses the network.

- [ ] **Step 9: Commit the executable runner**

```bash
git diff --cached --name-only
git add package.json scripts/external-benchmark-runner.mjs scripts/verify-external-benchmark-evidence.mjs src/benchmark/output-file.ts src/benchmark/external-manifest.ts src/benchmark/external-runner.ts src/cli/commands/benchmark.ts tests/unit/external-benchmark-output.test.ts tests/unit/external-benchmark-runner.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: run reproducible external benchmarks"
```

## Chunk 3: Operator Documentation

### Task 5: Document operation, artifacts, and failure policy

**Files:**
- Modify: `docs/benchmark-guardrails.md`
- Modify: `docs/benchmark-baseline-management.md`

- [ ] **Step 1: Document the exact cold command and artifact tree**

Add an “External repository evidence” section to `docs/benchmark-guardrails.md` with this command sequence:

```bash
npm run benchmark:setup-external -- --base-dir .tmp/external-benchmarks --out benchmarks/real-world/external-repos.config.json
npm run build:runtime
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-cold-smoke-v1 --cache-mode cold --repeats 1
```

Document this stable artifact layout:

```text
.benchmark/external/scip-io-cold-smoke-v1/
├── preflight.log
├── run-manifest.json
├── results.json
├── inputs/
│   ├── sdlmcp.config.json
│   ├── baseline.json
│   └── threshold.json
├── db/
│   ├── repeat-001.lbug
│   └── repeat-001.lbug.*
├── logs/
│   ├── repeat-001.stdout.log
│   └── repeat-001.stderr.log
└── raw/
    └── repeat-001.benchmark.json
```

Explain that `*.lbug.*` includes every produced WAL or sidecar. Before-manifest failures retain `preflight.log` plus `preflight-error.json`; after-manifest failures retain complete-count `results.json` plus declared logs. The artifact directory is ignored but intentionally retained by the root-workspace owner until the backlog evidence is archived or superseded explicitly.

- [ ] **Step 2: Document warm mode without claiming a warm result**

Add the exact follow-up form:

```bash
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-warm-smoke-v1 --cache-mode warm --warm-db .benchmark/external/scip-io-cold-smoke-v1/db/repeat-001.lbug --repeats 1
```

State that the runner fingerprints the source family before and after staging, rejects membership or byte drift, stages the entire family under `inputs/warm-db`, copies it exclusively to the absent repeat family, and never mutates the input snapshot. Do not mark a warm smoke as completed unless this command is actually run.

- [ ] **Step 3: Document baseline provenance and guardrails**

Update `docs/benchmark-baseline-management.md` to define format 1 as:

```json
{
  "formatVersion": 1,
  "repoId": "scip-io",
  "metrics": {
    "indexTimePerFile": 311.5638318181818,
    "indexTimePerSymbol": 10.534432838114753,
    "symbolsPerFile": 29.575757575757574,
    "edgesPerSymbol": 0.5527663934426229,
    "graphConnectivity": 0.2459016393442623,
    "exportedSymbolRatio": 0.992827868852459,
    "sliceBuildTimeMs": 465.69450000001234,
    "avgSkeletonTimeMs": 4.416600000001684,
    "avgCardTokens": 175.25,
    "avgSkeletonTokens": 2
  }
}
```

State explicitly:

- a baseline must match the selected `repoId`;
- a baseline update requires persisted repeated measurements and review;
- a baseline does not authorize a threshold edit;
- a failed threshold remains visible in `results.json` and causes a nonzero exit;
- never copy a result from a different target or platform silently.

- [ ] **Step 4: Run documentation checks**

Run: `npm run docs:tools:check`

Expected: PASS. This command includes workflow-document validation and generated tool-inventory validation; these docs do not change generated inventory.

- [ ] **Step 5: Commit the documentation**

```bash
git diff --cached --name-only
git add docs/benchmark-guardrails.md docs/benchmark-baseline-management.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: document external benchmark evidence"
```

## Chunk 4: Verification and Evidence Closeout

### Task 6: Run completion gates and the bounded scip-io smoke

**Files:**
- Modify after fresh evidence: `devdocs/plans/notes/2026-07-05-token-economy-status.md`
- Update locally after fresh evidence: `BACKLOG.md`
- Persist ignored artifacts: `.benchmark/external/scip-io-cold-smoke-v1/**`
- Persist default-DB proof: `.benchmark/external/scip-io-cold-smoke-v1.default-db-{before,after}.json`

Apply this failure handoff to every gate in Steps 1–9, including cleanup validation, root-workspace backlog reconciliation/readback, ignored-file validation, staging checks, and the tracked evidence commit:

- Before artifact-root creation, preserve the SDL runtime output handle and record exact command, exit code, stable boundary, and next action.
- After root creation but before the manifest, preserve `preflight.log` and `preflight-error.json`.
- After the manifest, preserve `run-manifest.json`, complete-count `results.json`, and declared logs/raw files.
- Stop at the first failed gate. Leave the backlog item unchecked and do not run the smoke, retry a stable output name, weaken a threshold, or delete evidence.
- The implementation-worktree agent sends the four-field handoff to the root-workspace owner. Only that owner edits the ignored authoritative `BACKLOG.md`, then reads it back through `sdl.file.read`.

- [ ] **Step 1: Verify the focused implementation**

Run each command separately:

```bash
npm run build:all
npm run typecheck
npm run lint
node --test tests/unit/external-benchmark-output.test.ts tests/unit/external-benchmark-manifest.test.ts tests/unit/external-benchmark-runner.test.ts tests/unit/real-world-benchmark-matrix.test.ts
node --experimental-strip-types --test tests/unit/setup-external-benchmark-repos.test.ts tests/unit/benchmark-baseline-repo.test.ts
npm run docs:tools:check
node --experimental-strip-types scripts/check-tool-inventory.ts
```

Expected: every command exits 0. Lint reports zero errors. `docs:tools:check` explicitly expands to workflow-document and generated-inventory validation; the direct inventory command proves the generated file remains current.

- [ ] **Step 2: Run shared determinism and full-suite gates**

Run:

```bash
npm run test:golden
node --test tests/integration/determinism.test.ts
npm test
```

Expected: all three commands exit 0. The named integration file is the explicit prompt-cache determinism gate. If any command fails, apply the gate-failure handoff and stop before the external smoke.

- [ ] **Step 3: Confirm the runner source state is committed**

Run:

```bash
git status --short
node --input-type=module -e "import { existsSync, mkdirSync } from 'node:fs'; const paths = ['.benchmark/external/scip-io-cold-smoke-v1', '.benchmark/external/scip-io-cold-smoke-v1.default-db-before.json', '.benchmark/external/scip-io-cold-smoke-v1.default-db-after.json']; if (paths.some(existsSync)) process.exit(1); mkdirSync('.benchmark/external', { recursive: true });"
node --input-type=module -e "const { writeDbFamilyFingerprintFile } = await import('./dist/benchmark/external-runner.js'); writeDbFamilyFingerprintFile('data/sdl-mcp-graph.lbug', '.benchmark/external/scip-io-cold-smoke-v1.default-db-before.json');"
```

Expected: `git status --short` prints nothing; the fixed artifact root and both fingerprint filenames were absent; the before fingerprint is created exclusively. A dirty runner is recordable in general, but this completion smoke requires a clean commit and stable threshold/launcher bytes.

- [ ] **Step 4: Prepare the locked checkout without benchmarking it**

Run:

```bash
npm run benchmark:setup-external -- --base-dir .tmp/external-benchmarks --out benchmarks/real-world/external-repos.config.json
git diff --exit-code -- benchmarks/real-world/external-repos.config.json
```

Expected: the setup script resolves `scip-io` at `2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd`, and the generated config has no diff because paths are repository-relative and deterministic.

- [ ] **Step 5: Run one cold external repeat**

Run:

```powershell
npm run build:runtime
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-cold-smoke-v1 --cache-mode cold --repeats 1
$benchmarkExit = $LASTEXITCODE
node --input-type=module -e "const { writeDbFamilyFingerprintFile } = await import('./dist/benchmark/external-runner.js'); writeDbFamilyFingerprintFile('data/sdl-mcp-graph.lbug', '.benchmark/external/scip-io-cold-smoke-v1.default-db-after.json');"
$fingerprintExit = $LASTEXITCODE
if ($fingerprintExit -ne 0) { exit $fingerprintExit }
node --input-type=module -e "import { readFileSync } from 'node:fs'; const before = readFileSync('.benchmark/external/scip-io-cold-smoke-v1.default-db-before.json'); const after = readFileSync('.benchmark/external/scip-io-cold-smoke-v1.default-db-after.json'); if (!before.equals(after)) process.exit(1);"
$defaultDbCompareExit = $LASTEXITCODE
if ($defaultDbCompareExit -ne 0) { exit $defaultDbCompareExit }
if ($benchmarkExit -ne 0) { exit $benchmarkExit }
```

Expected green result: exit 0; `run-manifest.json` and `results.json` exist; `results.json.passed` is true; one raw result, stdout log, stderr log, isolated DB family, staged threshold, and launcher hash exist; the default-DB before/after files were byte-compared before the benchmark exit code was propagated.

If the command exits nonzero, do not delete the artifact, reuse the same directory, edit a threshold, or check the backlog item. If no artifact root exists, use the persisted runtime handle. If `preflight-error.json` exists without a manifest, record that boundary and log. If the manifest exists, require complete-count `results.json` and read its stable failure boundary plus declared logs. Apply the root-workspace backlog handoff and stop.

- [ ] **Step 6: Execute the integrity verifier**

Run:

```bash
npm run benchmark:external:verify -- --root .benchmark/external/scip-io-cold-smoke-v1 --repo-id scip-io --source-ref 2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd --source-commit 2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd --cache-mode cold --repeats 1 --default-db-before .benchmark/external/scip-io-cold-smoke-v1.default-db-before.json --default-db-after .benchmark/external/scip-io-cold-smoke-v1.default-db-after.json
```

Expected: the command exits 0 and the verifier prints exactly one success line. This executable gate checks target/ref/commit, clean flags, cold semantics, complete repeat count, canonical relative containment, prohibited fields, every declared artifact, staged input hashes, raw-result hashes, benchmarkResultSha256, strict threshold evidence, manifest-byte hash, top-level pass status, and byte-identical default-DB before/after families. No manual inspection substitutes for this command.

- [ ] **Step 7: Perform targeted cleanup without deleting evidence**

All unit-test temporary directories must already be removed by their named `afterEach` cleanup. During implementation, maintain an exact list of SDL edit-backup paths returned by write operations; remove only those captured paths after verifying each is inside the implementation worktree. If the list is empty, perform no filesystem deletion. Do not remove:

- `.benchmark/external/scip-io-cold-smoke-v1`;
- its DB, WAL, sidecars, logs, raw result, manifest, or result file;
- `.tmp/external-benchmarks/scip-io`, which remains the pinned reusable checkout;
- either default-DB before/after fingerprint file;
- any pre-existing database or artifact.

The root-workspace owner retains these ignored evidence files until the backlog entry is archived or a later authorized run explicitly supersedes them.

Run: `git status --short`

Expected: no `.bak` files and no unexpected tracked changes.

- [ ] **Step 8: Reconcile status and backlog from the fresh result**

On green only, update `devdocs/plans/notes/2026-07-05-token-economy-status.md` with the exact artifact path, exact `runManifestSha256` read from `results.json`, target commit, cache mode, repeat count, and pass status. Replace the old baseline-mismatch statement; do not erase its historical context without recording that the new target-specific baseline supersedes it.

The implementation worktree must not assume ignored `BACKLOG.md` exists or try to commit it. Send the artifact path, exact `runManifestSha256`, target commit, cache mode, repeat count, threshold hash/unchanged state, verifier result, and any failure boundary to the root-workspace owner. That owner reads `BACKLOG.md` through SDL, marks “Make benchmark validation reproducible for external repositories” complete only when every gate and verifier are green, writes the evidence, and performs an SDL readback.

On any gate failure, keep the backlog checkbox unchecked and record exact command, exit code, runtime/artifact handle, stable boundary, and next action in both the status note and root backlog.

- [ ] **Step 9: Validate ignored backlog continuity and commit tracked evidence**

Run: `git check-ignore -q BACKLOG.md`

Expected: exit 0.

Run:

```bash
git diff --cached --name-only
git add devdocs/plans/notes/2026-07-05-token-economy-status.md
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: record external benchmark validation"
```

Expected: the first staged-file listing is empty, the second contains only the tracked status-note evidence, and the commit succeeds. `BACKLOG.md`, `.benchmark/external/**`, and the default-DB fingerprint files remain intentionally ignored local evidence.

### Acceptance checklist

- [ ] The exact `scip-io` remote/ref is pinned and generated config paths are stable across machines.
- [ ] The baseline is version 1, target-matched, minimal, committed, and derived from persisted measurement.
- [ ] Identical inputs produce byte-identical `run-manifest.json` bytes.
- [ ] The manifest identifies target tree, optional SCIP artifact, runner commit/dirty state, exact `dist/` tree, launcher bytes, config, baseline, threshold source/copy, platform, architecture, cache mode, repeats, commands, and initial DB files.
- [ ] Cold mode refuses every existing DB-family member without deleting it.
- [ ] Warm mode stages, hashes, exclusively copies, and revalidates every primary/WAL/sidecar file.
- [ ] `SDL_CONFIG`, `SDL_GRAPH_DB_PATH`, and `SDL_DB_PATH` are exact and canonically isolated; inherited `SDL_GRAPH_DB_DIR` is removed and rejected.
- [ ] Target/ref, baseline format/target, runner state, and build-tree mismatches prevent child execution.
- [ ] `results.json` references the exact manifest hash, contains exactly the requested repeat count, records stable failure boundaries, preserves run-specific timings/status/metrics, and sorts non-empty strict threshold evidence.
- [ ] Threshold failures remain nonzero failures and no threshold is weakened.
- [ ] The executable verifier proves every declared artifact/hash and byte-identical default-project-DB before/after families for the bounded `scip-io` smoke.
- [ ] Temporary test state and edit backups are removed while benchmark evidence remains.
- [ ] Shared build, typecheck, focused tests, lint, docs checks, golden validation, and full `npm test` gates pass before completion is claimed.
