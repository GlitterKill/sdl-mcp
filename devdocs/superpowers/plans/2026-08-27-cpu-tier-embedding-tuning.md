# CPU-Tier Embedding Tuning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make omitted CPU embedding settings scale to estimated physical-core width and startup free memory, with a measured minimum-wall-time 9950X3D result that stays within the approved peak-RSS guardrail.

**Architecture:** Keep CPU topology estimation in `cpu-detect.ts`, derive reusable CPU and free-memory bounds in `cpu-presets.ts`, and consume the CPU width in ONNX runtime auto-thread resolution. Sample `os.freemem()` once in `loadConfig()`, apply detected and pinned tier presets through the same path, and preserve every raw user override. Keep FileSummary batch size 4, execution providers, models, inter-op threads, and execution mode unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 24 built-in test runner, Zod 4 configuration schemas, `onnxruntime-node@1.24.3`, native `tokenizers`.

**Approved design:** `devdocs/superpowers/specs/2026-08-27-cpu-tier-embedding-tuning-design.md`

**Required workflows:** `@test-driven-development`, `@test-scope`, `@verification-before-completion`, then `@subagent-driven-development` for execution.

**Index safety:** Do not call `index.refresh`, `sdl.workflow` with an indexing action, or `sdl-mcp index`. A disposable full-index A/B requires separate explicit user authorization in the turn where it runs.

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/util/cpu-presets.ts` | Derive bounded embedding width and merge omitted semantic preset values. |
| `src/config/loadConfig.ts` | Apply both auto-detected and explicitly pinned tier presets. |
| `src/indexer/embeddings-local.ts` | Use the derived width for ONNX runtime auto-thread resolution. |
| `tests/unit/cpu-tier-embedding-presets.test.ts` | Pure width, tier, and raw override contract tests. |
| `tests/unit/config-loading.test.ts` | End-to-end config loading, pinned tier, example config, and explicit override tests. |
| `tests/unit/embeddings-execution-providers.test.ts` | ONNX auto-thread and partial nested configuration behavior. |
| `scripts/benchmark-cpu-embedding-tiers.mjs` | Reproducible non-CI Jina CPU comparison at widths 2, 4, 6, and 8. |
| `src/config/types.ts` | Explain schema fallback versus tier-derived effective defaults. |
| `src/util/cpu-presets.ts` | Keep the preset table synchronized with semantic behavior. |
| `config/sdlmcp.config.example.json` | Stop pinning obsolete concurrency and batch defaults. |
| `config/sdlmcp.config.schema.json` | Describe effective tier defaults without changing validation fallback values. |
| `docs/configuration-reference.md` | Public configuration and migration guidance. |
| `docs/feature-deep-dives/semantic-embeddings-setup.md` | Public tuning behavior, formula, and 9950X3D evidence. |
| `src/ui/config.js` | Admin UI help text for effective embedding defaults. |

---

## Chunk 1: Derive and Consume CPU Embedding Width

### Task 1: Add failing pure preset tests

**Files:**
- Create: `tests/unit/cpu-tier-embedding-presets.test.ts`
- Test: `tests/unit/cpu-tier-embedding-presets.test.ts`

- [x] **Step 1: Create the focused test file**

Add tests that import the future exports from compiled `dist`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveEmbeddingWidth,
  resolvePerformancePresets,
} from "../../dist/util/cpu-presets.js";

describe("CPU-tier embedding presets", () => {
  it("derives physical-core width and caps it at eight", () => {
    assert.equal(resolveEmbeddingWidth({ logicalCores: 1 }), 1);
    assert.equal(resolveEmbeddingWidth({ logicalCores: 2 }), 1);
    assert.equal(resolveEmbeddingWidth({ logicalCores: 7 }), 4);
    assert.equal(
      resolveEmbeddingWidth({ logicalCores: 8, physicalCores: 4 }),
      4,
    );
    assert.equal(
      resolveEmbeddingWidth({ logicalCores: 12, physicalCores: 6 }),
      6,
    );
    assert.equal(
      resolveEmbeddingWidth({ logicalCores: 20, physicalCores: 10 }),
      8,
    );
    assert.equal(
      resolveEmbeddingWidth({ logicalCores: 32, physicalCores: 16 }),
      8,
    );
  });

  it("scales semantic defaults across every tier", () => {
    const cases = [
      ["mid", { logicalCores: 8, physicalCores: 4 }, 4, 4],
      ["high", { logicalCores: 12, physicalCores: 6 }, 6, 8],
      ["extreme", { logicalCores: 32, physicalCores: 16 }, 8, 12],
    ] as const;

    for (const [tier, profile, width, indexingConcurrency] of cases) {
      const result = resolvePerformancePresets(tier, {}, profile);
      assert.equal(result.embeddingConcurrency, width);
      assert.equal(result.embeddingBatchSize, 16);
      assert.equal(result.indexingConcurrency, indexingConcurrency);
    }
  });

  it("preserves raw semantic overrides", () => {
    const result = resolvePerformancePresets(
      "extreme",
      {
        semantic: {
          embeddingConcurrency: 3,
          embeddingBatchSize: 24,
        },
      },
      { logicalCores: 32, physicalCores: 16 },
    );

    assert.equal(result.embeddingConcurrency, 3);
    assert.equal(result.embeddingBatchSize, 24);
  });
});
```

- [x] **Step 2: Build current source and verify RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test tests/unit/cpu-tier-embedding-presets.test.ts
```

Expected: the test fails because `resolveEmbeddingWidth` is not exported and
`resolvePerformancePresets` does not accept a CPU profile or return semantic
embedding fields.

### Task 2: Implement the bounded width and semantic preset merge

**Files:**
- Modify: `src/util/cpu-presets.ts:1-190`
- Modify: `src/config/loadConfig.ts:132-138`
- Test: `tests/unit/cpu-tier-embedding-presets.test.ts`

- [x] **Step 1: Add the minimum imports and resolved fields**

Import `MAX_EMBEDDING_CONCURRENCY` and the `CpuProfile` type. Add only these
fields to the resolved preset result:

```typescript
export interface ResolvedPerformancePresets extends PerformancePresets {
  embeddingConcurrency: number;
  embeddingBatchSize: number;
}
```

Do not add FileSummary batch, execution provider, inter-op, or execution-mode
fields to the tier preset.

- [x] **Step 2: Add the pure width helper**

```typescript
export function resolveEmbeddingWidth(
  profile: Pick<CpuProfile, "logicalCores" | "physicalCores">,
): number {
  // A classic Zen CCD has at most eight physical cores. The same cap keeps
  // this cross-platform when portable APIs cannot expose cache topology.
  const estimatedPhysicalCores =
    profile.physicalCores ?? Math.ceil(profile.logicalCores / 2);
  return Math.min(
    MAX_EMBEDDING_CONCURRENCY,
    Math.max(1, estimatedPhysicalCores),
  );
}
```

- [x] **Step 3: Extend `resolvePerformancePresets`**

Change its signature to accept a profile and return
`ResolvedPerformancePresets`:

```typescript
export function resolvePerformancePresets(
  tier: CpuTier,
  userConfig: DeepPartial<AppConfig>,
  cpuProfile: Pick<CpuProfile, "logicalCores" | "physicalCores">,
): ResolvedPerformancePresets {
  const presets = getTierPresets(tier);
  const embeddingWidth = resolveEmbeddingWidth(cpuProfile);

  return {
    // Preserve every existing field exactly.
    // ...existing preset resolution...
    embeddingConcurrency:
      userConfig.semantic?.embeddingConcurrency ?? embeddingWidth,
    embeddingBatchSize:
      userConfig.semantic?.embeddingBatchSize ?? 16,
  };
}
```

Use nullish coalescing so explicit positive values remain authoritative. Do not
route `semantic.onnx.intraOpNumThreads` through this config result; runtime
auto-thread resolution consumes the same width helper in Task 3 without
materializing a previously absent nested `onnx` object.

- [x] **Step 4: Keep the existing loader caller compiling**

Pass the already-detected `cpuProfile` as the third argument at the current
`resolvePerformancePresets(...)` call in `loadConfig.ts`. Do not yet change the
auto-tier gate or apply semantic values; Chunk 2 owns that behavior change.

- [x] **Step 5: Build and verify GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test tests/unit/cpu-tier-embedding-presets.test.ts
```

Expected: all three tests pass.

### Task 3: Apply the same width to ONNX runtime auto threads

**Files:**
- Modify: `src/indexer/embeddings-local.ts:8-11,264-320`
- Modify: `tests/unit/embeddings-execution-providers.test.ts:193-220`
- Test: `tests/unit/embeddings-execution-providers.test.ts`

- [x] **Step 1: Add a failing CPU auto-thread test**

Import `availableParallelism` from `node:os`, then add one test beside the
current CPU throughput option test. Choose a fake profile whose width is
guaranteed to differ from the host's old default:

```typescript
it("uses the derived CPU width when ONNX threads remain automatic", async () => {
  const module = await import("../../dist/indexer/embeddings-local.js");
  const resolver = Reflect.get(module, "resolveEmbeddingSessionOptions");
  const expectedWidth = availableParallelism() === 8 ? 1 : 8;
  const cpuProfile =
    expectedWidth === 1
      ? { logicalCores: 1, physicalCores: 1 }
      : { logicalCores: 32, physicalCores: 16 };

  assert.deepStrictEqual(
    resolver({
      requestedProviders: ["cpu"],
      onnxConfig: undefined,
      deterministic: false,
      cpuProfile,
      platformOverride: WIN32,
    }),
    {
      executionProviders: ["cpu"],
      intraOpNumThreads: expectedWidth,
      interOpNumThreads: 1,
      executionMode: "sequential",
      enableMemPattern: true,
      serializeRuns: false,
    },
  );
});
```

Expected before the fix: the resolver ignores `cpuProfile` and returns the
host's `availableParallelism()` value, which differs from `expectedWidth` by
construction.

- [x] **Step 2: Run and verify RED**

Run the focused execution-provider test and confirm the new behavioral case
fails. Do not add a source-text assertion.

- [x] **Step 3: Replace the runtime default**

Remove the existing `autoThreads = availableParallelism()` parameter default.
Keep `autoThreads` optional, add an optional `cpuProfile` input for deterministic
testing, and resolve the automatic value inside the function:

```typescript
autoThreads,
cpuProfile = detectCpuProfile(),
// ...
const resolvedAutoThreads =
  autoThreads ?? resolveEmbeddingWidth(cpuProfile);
```

Update imports accordingly and remove `availableParallelism` when unused.
Explicit positive `onnx.intraOpNumThreads` still wins. Explicit `0` continues
to mean automatic and therefore resolves through `resolvedAutoThreads`.

- [x] **Step 4: Build and run focused tests**

Run:

```powershell
npm run build
node --experimental-strip-types --test tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/embeddings-execution-providers.test.ts
```

Expected: both files pass with no warnings.

- [x] **Step 5: Commit Chunk 1**

```powershell
git add src/util/cpu-presets.ts src/config/loadConfig.ts src/indexer/embeddings-local.ts tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/embeddings-execution-providers.test.ts
git commit -m "perf(index): derive CPU embedding width"
```

---

## Chunk 2: Apply Tier Defaults Through Config Loading

### Task 4: Add failing end-to-end config tests

**Files:**
- Modify: `tests/unit/config-loading.test.ts:1-70`
- Test: `tests/unit/config-loading.test.ts`

- [x] **Step 1: Add temporary-config helpers**

Import `mkdtempSync`, `rmSync`, and `writeFileSync` from `node:fs`, `tmpdir`
from `node:os`, `join` from `node:path`, plus `invalidateConfigCache`,
`detectCpuProfile`, and `resolveEmbeddingWidth` from compiled `dist`.

Add a local helper that writes `{ repos: [], policy: {}, ...overrides }` to a
new temporary directory, calls `invalidateConfigCache()` before loading, and
removes the directory in `finally`. Keep each test responsible for its own
temporary directory.

- [x] **Step 2: Add the failing example/auto-tier test**

Extend `should load example config successfully`:

```typescript
const expectedWidth = resolveEmbeddingWidth(detectCpuProfile());
assert.equal(config.semantic?.embeddingBatchSize, 16);
assert.equal(config.semantic?.embeddingConcurrency, expectedWidth);
assert.equal(config.semantic?.fileSummaryEmbeddingBatchSize, 4);
```

Expected before the fix: batch remains 32 and concurrency remains 1 because
the example config pins both fields.

- [x] **Step 3: Add the failing pinned-tier test**

Load a temporary config with `performanceTier: "extreme"` and no explicit
performance fields. Assert:

```typescript
assert.equal(config.indexing?.concurrency, 12);
assert.equal(config.semantic?.embeddingBatchSize, 16);
assert.equal(config.semantic?.embeddingConcurrency, expectedWidth);
assert.equal(config.semantic?.fileSummaryEmbeddingBatchSize, 4);
```

Expected before the fix: pinned `extreme` bypasses preset application.

- [x] **Step 4: Add explicit override coverage**

Load a pinned config containing:

```typescript
semantic: {
  embeddingBatchSize: 24,
  embeddingConcurrency: 3,
  fileSummaryEmbeddingBatchSize: 7,
  onnx: {
    intraOpNumThreads: 0,
    executionMode: "parallel",
  },
},
indexing: { concurrency: 5 },
```

Assert every explicit value survives, `onnx.interOpNumThreads` retains its
schema fallback, and unrelated preset fields such as `pass2Concurrency` come
from the selected tier. Before the fix, the explicit values remain green but
the selected-tier assertion is RED because pinned tiers bypass presets.

- [x] **Step 5: Run and verify RED**

Run:

```powershell
npm run build
node --experimental-strip-types --test tests/unit/config-loading.test.ts
```

Expected: the example and pinned-tier tests fail on the old effective values.
In the explicit-override test, the explicit 24/3/7/0/parallel assertions remain
green while the selected-tier `pass2Concurrency` assertion fails.

### Task 5: Fix shared preset application and the shipped example

**Files:**
- Modify: `src/config/loadConfig.ts:124-196`
- Modify: `config/sdlmcp.config.example.json:173-178`
- Test: `tests/unit/config-loading.test.ts`

- [x] **Step 1: Resolve the CPU profile and effective tier once**

Replace the `if (config.performanceTier === "auto")` gate with:

```typescript
const cpuProfile = detectCpuProfile();
const effectiveTier =
  config.performanceTier === "auto"
    ? cpuProfile.detectedTier
    : config.performanceTier;
const presets = resolvePerformancePresets(
  effectiveTier,
  rawConfig as Parameters<typeof resolvePerformancePresets>[1],
  cpuProfile,
);
```

Apply the existing tier-adjusted config construction for both auto and pinned
tiers. Preserve the current raw pre-Zod override behavior for every existing
field.

- [x] **Step 2: Overlay only the two semantic config fields**

Within the existing `semantic` construction, add:

```typescript
embeddingConcurrency: presets.embeddingConcurrency,
embeddingBatchSize: presets.embeddingBatchSize,
```

Do not create or rewrite `semantic.onnx`; `embeddings-local.ts` handles the
automatic intra-op width at session resolution. Spreading `baseSemantic`
preserves explicit FileSummary and nested ONNX values.

- [x] **Step 3: Stop the example config from defeating presets**

Remove only these lines from `config/sdlmcp.config.example.json`:

```json
"embeddingConcurrency": 1,
"embeddingBatchSize": 32,
```

Keep `fileSummaryEmbeddingBatchSize: 4` because it is deliberately not
tier-derived.

- [x] **Step 4: Build and verify GREEN**

Run:

```powershell
npm run build
node --experimental-strip-types --test tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/config-loading.test.ts tests/unit/embeddings-execution-providers.test.ts tests/unit/embeddings-config-knobs.test.ts
```

Expected: all focused tests pass. Confirm the explicit override test reports
24/3/7/0/parallel exactly.

- [x] **Step 5: Commit Chunk 2**

```powershell
git add src/config/loadConfig.ts config/sdlmcp.config.example.json tests/unit/config-loading.test.ts
git commit -m "perf(config): apply CPU embedding tier presets"
```

---

## Chunk 3: Reproducible Benchmark and Documentation

> **Historical completion note:** Tasks 6-8 record the first implementation
> and its original evidence. Independent review invalidated that benchmark
> acceptance. Chunk 4 supersedes its sampling, selection, production gate, and
> release-readiness steps; do not use Tasks 6-8 as the merge gate.

### Approved revision: free-memory and peak-RSS contract

Before Task 6 is accepted:

- run each benchmark shape in a fresh child process;
- report `process.resourceUsage().maxRSS` beside median throughput;
- test the CPU memory arena explicitly while retaining memory patterns and
  full graph optimization;
- require width-8 throughput uplift of at least 15%; and
- require peak RSS no higher than baseline plus the larger of 10% or 128 MiB.

After the benchmark selects the ample-memory shape, add pure preset tests for
free-memory snapshots below 2, 4, 8, and 16 GiB. Automatic concurrency must be
`min(cpuWidth, memoryWidth)`, where `memoryWidth` is the free-memory GiB count
clamped to 1-8. Below 4 GiB, use symbol batch 8; otherwise use the measured
default batch. Explicit `embeddingConcurrency` and `embeddingBatchSize` remain
authoritative. Sample `os.freemem()` once in `loadConfig()` so settings remain
stable throughout a refresh.

### Task 6: Add the manual CPU embedding benchmark

**Files:**
- Create: `scripts/benchmark-cpu-embedding-tiers.mjs`
- Verify: `scripts/benchmark-cpu-embedding-tiers.mjs`

- [x] **Step 1: Implement the fixed-scope benchmark**

The script must:

1. Run from repository root after `npm run build`.
2. Import `onnxruntime-node`, `tokenizers`, `runBatchInference`, and model path
   helpers.
3. Recursively collect `.ts` excerpts from `src/indexer`, `src/db`, and
   `src/mcp`; sort normalized repository-relative paths before extraction,
   use deterministic excerpt boundaries and length/path tie-breakers, and keep
   the first 192 length-sorted inputs between 80 and 1,800 characters. Use no
   random sampling.
4. Compare the existing width-8 shape against a small explicit candidate set
   covering batch and CPU-arena on/off with candidate concurrency fixed at
   width 8. Do not use a combinatorial sweep.
5. Run every shape in a separate child process, warm its session, run three
   measured iterations, and report median milliseconds, texts/s, and peak RSS.
6. A candidate qualifies when
   `candidateKiB <= baselineKiB + max(baselineKiB * 0.10, 128 * 1024)`.
   Select the fastest qualifying candidate. Print `PASS` only when it improves
   width-8 throughput by at least 15%; otherwise print `FAIL` and set
   `process.exitCode = 1`.

Use `executionProviders: ["cpu"]`, `interOpNumThreads: 1`, sequential mode,
memory patterns enabled, and graph optimization level `all` for both shapes.
Release every session in `finally`. Add comments explaining that the benchmark
checks inference-path tuning only, not persistence, HNSW, or total index time.

- [x] **Step 2: Build and run the benchmark**

Run:

```powershell
npm run build
node scripts/benchmark-cpu-embedding-tiers.mjs
```

Expected on the 9950X3D: every candidate prints throughput and isolated peak
RSS; the accepted candidate reports `PASS` for both gates. Record actual
medians and peak RSS in the task handoff. Do not run an index refresh.

- [x] **Step 3: Commit the benchmark**

```powershell
git add scripts/benchmark-cpu-embedding-tiers.mjs
git commit -m "perf(index): add CPU embedding tier benchmark"
```

### Task 7: Synchronize configuration documentation

**Files:**
- Modify: `src/util/cpu-presets.ts`
- Modify: `src/config/loadConfig.ts`
- Modify: `src/indexer/embeddings-local.ts`
- Modify: `tests/unit/cpu-tier-embedding-presets.test.ts`
- Modify: `tests/unit/config-loading.test.ts`
- Modify: `tests/unit/embeddings-execution-providers.test.ts`
- Modify: `src/config/types.ts:597-735,1213-1226`
- Modify: `src/util/cpu-presets.ts:5-45`
- Modify: `config/sdlmcp.config.schema.json:188-196,955-970`
- Modify: `docs/configuration-reference.md:190-205,375-392`
- Modify: `docs/feature-deep-dives/semantic-embeddings-setup.md:589-630,805-820`
- Modify: `src/ui/config.js:237-238`

- [x] **Step 1: Implement and test the free-memory bound**

Add a pure free-memory-width helper that converts bytes to whole GiB and
clamps the result to 1-8. Pass a single `os.freemem()` snapshot from
`loadConfig()` into `resolvePerformancePresets()`. For omitted fields, set
concurrency to `min(cpuWidth, memoryWidth)` and use batch 8 below 4 GiB;
otherwise use the benchmark-selected ample-memory batch. Preserve explicit
semantic overrides exactly. Add pure boundary tests and config-loading tests
with injected free-memory values; do not poll memory during inference.

Apply the benchmark-selected global CPU arena setting in
`embeddings-local.ts`, and explicitly set graph optimization to `all` for the
CPU path. Preserve DirectML behavior. Cover the resolved session options in
the existing execution-provider test.

- [x] **Step 2: Update source comments and the preset table**

Document the effective formula:

```text
cpuWidth = min(8, estimatedPhysicalCores)
memoryWidth = clamp(floor(freeMemoryGiB), 1, 8)
embeddingConcurrency = min(cpuWidth, memoryWidth)
```

State that omitted symbol batch size becomes 8 below 4 GiB free and the
measured ample-memory batch otherwise. Omitted concurrency becomes the smaller
of CPU and memory width; automatic ONNX intra-op width remains CPU-derived.
FileSummary batch remains 4. Clarify that Zod's 1/32/0 values are schema
fallbacks; the loader and runtime replace them only when the raw field was
omitted or explicitly set to ONNX auto (`0`).

- [x] **Step 3: Update public docs and migration guidance**

In both public documents:

- replace the old 9950X3D advice (`batch=32`, concurrency 4, threads 16),
- show the measured ample-memory extreme profile selected by Task 6,
- add `embeddingBatchSize` and `embeddingConcurrency` to the
  `performanceTier`-affected field list in `configuration-reference.md`,
- replace the `onnx.intraOpNumThreads: 0` claim that uses
  `os.availableParallelism()` with the new physical-core-derived width,
- explain that `embeddingConcurrency` also controls FileSummary calls while
  their batch remains 4,
- state that existing configs opt in by deleting explicit
  `embeddingConcurrency`, `embeddingBatchSize`, and positive
  `onnx.intraOpNumThreads`, and
- retain explicit override guidance for unusual no-SMT, ARM, VM, or
  misreported hosts.

- [x] **Step 4: Update schema and UI descriptions without changing schema defaults**

Keep JSON-schema `default` annotations at 1 and 32 for compatibility. Change
their descriptions to call them schema fallbacks and describe the effective
tier behavior. Update UI tooltips to describe the CPU/free-memory concurrency
bound and the constrained/ample symbol batches.

- [x] **Step 5: Run documentation/config checks**

Run:

```powershell
npm run build:all
npm run check:config-sync
npm run typecheck
npm run lint
npm run test:harness
```

Expected: all commands exit 0. If lint reports pre-existing unrelated files,
run ESLint on the changed `src` files and report both results without editing
unrelated code.

- [x] **Step 6: Commit documentation**

```powershell
git add src/config/loadConfig.ts src/config/types.ts src/indexer/embeddings-local.ts src/util/cpu-presets.ts tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/config-loading.test.ts tests/unit/embeddings-execution-providers.test.ts config/sdlmcp.config.schema.json docs/configuration-reference.md docs/feature-deep-dives/semantic-embeddings-setup.md src/ui/config.js
git commit -m "docs: explain CPU-tier embedding defaults"
```

### Task 8: Final verification

**Files:**
- Verify all changed paths.

- [x] **Step 1: Determine the targeted suite from the final diff**

Run:

```powershell
git diff --name-only 3d891588..HEAD
```

Expected affected suites: build, typecheck, lint, focused CPU/config/embedding
unit tests, configuration sync, the adapter harness because
`src/indexer/embeddings-local.ts` changed, and the full test suite because
`src/config/**` changed. Native parity, golden snapshots, property tests, and
stress tests are not triggered by these paths.

- [x] **Step 2: Run focused verification from a fresh build**

```powershell
npm run build:all
node --experimental-strip-types --test tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/config-loading.test.ts tests/unit/embeddings-execution-providers.test.ts tests/unit/embeddings-config-knobs.test.ts
npm run check:config-sync
npm run typecheck
npm run lint
npm run test:harness
```

Expected: every command exits 0.

- [x] **Step 3: Run the full suite required for config changes**

```powershell
npm test
```

Expected: full suite passes. If known shared temporary-state failures recur,
report the aggregate result and rerun only those files with fresh `TEMP` and
`TMP` roots; do not describe the aggregate suite as green unless it is green.

- [x] **Step 4: Re-run the manual performance gate**

```powershell
node scripts/benchmark-cpu-embedding-tiers.mjs
```

Expected on the 9950X3D: width-8 scaled median is at least 15% faster and the
script prints `PASS`. This is not a full-index claim.

- [x] **Step 5: Inspect repository hygiene**

```powershell
git diff --check
git status --short --branch
```

Expected: no whitespace errors and no unrelated paths. The branch is local-only
and ahead of `origin/main`; do not push.

- [x] **Step 6: Request code review before integration**

Use `@requesting-code-review` against the complete implementation diff. Address
only verified findings through `@receiving-code-review`, rerun the smallest
affected checks after each code change, and then repeat final verification if
production code changed.

---

## Chunk 4: Independent Review Remediation

This chunk supersedes the Task 6-8 benchmark acceptance. Keep the 15% and peak-
RSS thresholds unchanged. Do not retain or commit production defaults until a
rebuilt production tuple passes its own gate.

### Task 9: Pin deterministic aggregation and production-gate behavior

**Files:**
- Create: `scripts/cpu-embedding-benchmark-contract.mjs`
- Create: `tests/unit/cpu-embedding-benchmark-contract.test.ts`

- [x] **Step 1: Write failing contract tests**

Cover these behaviors with synthetic records:

```typescript
test("an experimental winner cannot pass a failing production shape", () => {
  const result = evaluateProductionGate({
    baseline: aggregateShapeSamples(BASELINE, baselineSamples, 3),
    production: aggregateShapeSamples(PRODUCTION, productionBelowGate, 3),
  });
  assert.equal(result.passed, false);
  assert.equal(result.upliftPercent, 14);
});

test("uses median throughput and worst candidate RSS", () => {
  const production = aggregateShapeSamples(PRODUCTION, variedSamples, 3);
  assert.equal(production.textsPerSecond, 15);
  assert.equal(production.worstMaxRssKiB, 1_700_000);
});

test("rejects incomplete, mismatched, and invalid samples", () => {
  assert.throws(() => aggregateShapeSamples(PRODUCTION, twoSamples, 3));
  assert.throws(() => aggregateShapeSamples(PRODUCTION, wrongIdSamples, 3));
  assert.throws(() => aggregateShapeSamples(PRODUCTION, nonFiniteSamples, 3));
});
```

Use complete records with `id`, `batchSize`, `concurrency`, `texts`,
`milliseconds`, `textsPerSecond`, `maxRssKiB`, and the full session tuple:
`executionProviders`, `intraOpNumThreads`, `interOpNumThreads`,
`executionMode`, `enableCpuMemArena`, `enableMemPattern`, and
`graphOptimizationLevel`. Aggregation must reject any sample whose tuple does
not exactly match the requested shape. Tests assert returned behavior, not
mock-call existence.

- [x] **Step 2: Run the tests and verify RED**

```powershell
node --experimental-strip-types --test --test-isolation=none tests/unit/cpu-embedding-benchmark-contract.test.ts
```

Expected: FAIL because the contract module does not exist.

- [x] **Step 3: Implement the minimum pure contract**

Initially export:

```javascript
export function aggregateShapeSamples(shape, samples, expectedSamples) { /* validate exact records; median throughput and RSS; worst RSS */ }
export function evaluateProductionGate({ baseline, production, minimumUpliftPercent = 15 }) { /* production only */ }
export function rankQualifyingCandidates({ baseline, candidates, minimumUpliftPercent = 15 }) { /* reporting/selection evidence */ }
```

The RSS limit is
`medianBaselineKiB + max(medianBaselineKiB * 0.10, 128 * 1024)`.
`evaluateProductionGate` compares the production shape's worst RSS to that
limit. No timing assertion enters CI.

- [x] **Step 4: Run the contract tests and verify GREEN**

Run the Step 2 command. Expected: all tests pass.

- [x] **Step 5: Commit the contract**

```powershell
git add scripts/cpu-embedding-benchmark-contract.mjs tests/unit/cpu-embedding-benchmark-contract.test.ts
git commit -m "test(benchmark): pin production gate contract"
```

### Task 10: Measure fresh processes and gate the built production tuple

**Files:**
- Modify: `scripts/cpu-embedding-benchmark-contract.mjs`
- Modify: `scripts/benchmark-cpu-embedding-tiers.mjs`
- Modify: `tests/unit/cpu-embedding-benchmark-contract.test.ts`

- [x] **Step 1: Add failing shape and subprocess coverage**

Add a test proving the fixed sweep contains baseline, the exact production
shape, arena-on batches 8/12/16/20/24 without duplicating production, and one
arena-off observational control. Prove only the exact `production` aggregate
is passed to `evaluateProductionGate`.

Add RED tests for the real process wrapper using `t.mock.method` on the default
`node:child_process` export and a minimal `EventEmitter` child with readable
stdout/stderr streams. Verify spawn errors, signal exits, nonzero exits, empty
stdout, malformed JSON, and a returned tuple that differs from the requested
shape all reject. Verify exactly three samples are required before aggregation.

- [x] **Step 2: Run and verify RED**

Run the Task 9 test command. Expected: FAIL because production-shape
construction is not implemented.

- [x] **Step 3: Implement fresh-process sampling**

Make the smallest runner changes:

1. Import `resolvePerformancePresets` and `resolveEmbeddingSessionOptions` from
   `dist`; derive the ample-memory width-8 batch/concurrency and CPU session
   options from the built production code.
2. Each child warms once, measures once, releases the ONNX session in
   `finally`, and emits one JSON record containing the full requested session
   tuple and metrics.
3. A full parent run starts exactly three sequential child processes per
   shape. `--quick` uses one process and reports plumbing only; it cannot print
   performance `PASS`.
4. Move the parent/child completion wrapper into the benchmark contract module.
   It calls the default `node:child_process` object's `spawn`, rejects spawn
   errors, signal/nonzero exits, missing/malformed JSON, mismatched full tuple,
   or invalid metrics, and never aggregates a surviving subset. This keeps the
   test seam at the actual process boundary without a production-only injection
   parameter.
5. Aggregate with the Task 9 contract. Rank alternatives for evidence, but
   determine exit status from `evaluateProductionGate({ baseline,
   production })` only.

Task 10 may add the wrapper export used directly by the runner and tests; do
not add unrelated benchmark-framework exports.

- [x] **Step 4: Verify deterministic logic and quick plumbing**

```powershell
npm run build:all
node --experimental-strip-types --test --test-isolation=none tests/unit/cpu-embedding-benchmark-contract.test.ts
node scripts/benchmark-cpu-embedding-tiers.mjs --quick
```

Expected: tests pass; quick mode completes without a performance-pass claim.

- [x] **Step 5: Commit the stable runner**

```powershell
git add scripts/benchmark-cpu-embedding-tiers.mjs tests/unit/cpu-embedding-benchmark-contract.test.ts
git commit -m "fix(benchmark): gate the built embedding preset"
```

### Task 11: Make free-memory loader coverage exact and stable

**Files:**
- Modify: `src/config/loadConfig.ts`
- Modify: `tests/unit/config-loading.test.ts`

- [x] **Step 1: Add failing exact-memory tests**

Use Node's test-context `mock.method` on the default `node:os` export while
exercising real `loadConfig` calls. Prove:

- 2 GiB free resolves batch 8 and concurrency `min(cpuWidth, 2)`;
- 4 GiB free resolves batch 16 and concurrency `min(cpuWidth, 4)`; and
- one uncached load calls `freemem()` exactly once, while a cached second load
  returns the same values after the mock's closure changes to 8 GiB and does
  not call `freemem()` again.

- [x] **Step 2: Run and verify RED**

```powershell
npm run build:all
node --experimental-strip-types --test --test-isolation=none tests/unit/config-loading.test.ts
```

Expected: the exact tests fail because the current named import cannot be
replaced through the shared default `node:os` object.

- [x] **Step 3: Make the minimum loader change**

Replace the named `freemem` import with the default `node:os` object and call
`os.freemem()` once at preset resolution. Do not add a production injection
interface or test-only method.

- [x] **Step 4: Build and verify GREEN**

Run the Step 2 commands. Expected: exact boundary and cache tests pass.

- [x] **Step 5: Commit deterministic loader coverage**

```powershell
git add src/config/loadConfig.ts tests/unit/config-loading.test.ts
git commit -m "test(config): pin free-memory preset loading"
```

Task 11 recorded the then-current 4 GiB batch-16 boundary. Task 12's measured
selection supersedes that batch value with batch 8 at every memory level while
retaining the same one-snapshot concurrency bound.

### Task 12: Select, apply, and revalidate the production candidate

**Files:**
- Modify after measurement: `src/util/cpu-presets.ts`
- Modify after measurement: `tests/unit/cpu-tier-embedding-presets.test.ts`
- Modify: `CHANGELOG.md`
- Modify if evidence changes: `docs/configuration-reference.md`
- Modify if evidence changes: `docs/feature-deep-dives/semantic-embeddings-setup.md`
- Modify: `devdocs/superpowers/specs/2026-08-27-cpu-tier-embedding-tuning-design.md`
- Modify: `devdocs/superpowers/plans/2026-08-27-cpu-tier-embedding-tuning.md`

- [x] **Step 1: Run the full sweep against the current built preset**

```powershell
npm run build:all
node scripts/benchmark-cpu-embedding-tiers.mjs
```

Expected: three fresh samples for every fixed shape. If production fails but
an alternative clears both gates, record that candidate. If none qualifies,
restore automatic batch 32/concurrency 1 and remove the unproven speedup claim;
do not lower the 15% threshold.

- [x] **Step 2: Write the failing preset expectation**

When an alternative qualifies, change the pure preset test to the measured
batch/concurrency and run it before production code. Expected: FAIL against the
old preset. If none qualifies, write the baseline fallback expectation instead.

- [x] **Step 3: Apply only the measured preset**

Change the ample-memory automatic batch/concurrency values in
`src/util/cpu-presets.ts`. Preserve free-memory scaling, explicit overrides,
FileSummary batch 4, CPU width, and ONNX session behavior.

- [x] **Step 4: Rebuild and gate the exact production shape**

```powershell
npm run build:all
node --experimental-strip-types --test --test-isolation=none tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/cpu-embedding-benchmark-contract.test.ts
node scripts/benchmark-cpu-embedding-tiers.mjs
```

Expected: the rebuilt production shape itself clears at least 15% throughput
uplift and the peak-RSS limit. An experimental winner cannot substitute. If the
fallback baseline is retained, report that the optimization was withheld and
do not claim a passing performance gate.

- [x] **Step 5: Update release and evidence documentation**

Add one Unreleased `Changed` bullet to `CHANGELOG.md` covering automatic CPU/
free-memory defaults, pinned tiers, override precedence, and removing explicit
fields to opt in. Replace prior benchmark claims with the final three-process
evidence or state that the preset was withheld.

Outcome: the first sweep rejected built production batch 16 at 14.16% uplift,
then qualified batches 8 and 12. Batch 8 was fastest at 37.78% uplift and 993.8
MiB worst peak RSS. After rebuilding, exact production batch 8/concurrency 8
passed at 36.16% uplift and 947.1 MiB worst peak RSS against a 3,294.5 MiB
limit. All figures cover inference only, not total indexing.

- [x] **Step 6: Run affected verification**

```powershell
npm run build:all
npm run typecheck
npm run check:config-sync
node --experimental-strip-types --test --test-isolation=none tests/unit/cpu-embedding-benchmark-contract.test.ts tests/unit/cpu-tier-embedding-presets.test.ts tests/unit/config-loading.test.ts tests/unit/embeddings-execution-providers.test.ts
npm run test:harness
npm run lint
git diff --check
```

Expected: all commands pass; lint has zero errors. Do not run `index.refresh`.

- [ ] **Step 7: Commit documentation and request final review**

Stage only the reviewed paths, commit the final preset/evidence/docs, then run
`@requesting-code-review` against `b5ffb751..HEAD`. Do not merge or push.
