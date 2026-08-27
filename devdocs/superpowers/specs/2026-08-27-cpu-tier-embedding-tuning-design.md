# CPU-Tier Embedding Tuning Design

**Date:** 2026-08-27
**Status:** Approved for implementation (memory-aware revision)

## Objective

Reduce local CPU embedding wall time by extending SDL-MCP's existing CPU-tier
presets to cover symbol embedding batch width, embedding concurrency, and ONNX
Runtime thread settings. Automatic settings must be bounded by both CPU width
and free system memory measured once during configuration loading, while
preserving explicit user configuration.

The primary acceptance machine is an AMD Ryzen 9 9950X3D. It has 16 physical
cores across two eight-core CCDs. SDL-MCP should use one CCD's physical width
as the upper bound for a single embedding session without adding vendor- or
model-specific CPU detection.

## Current Behavior

- CPU detection classifies hosts by logical cores: `mid` for 1-8, `high` for
  9-20, and `extreme` for 21 or more.
- Tier presets tune indexing, pools, pass-2, summaries, and related work, but
  do not tune embedding concurrency, symbol batch size, or ONNX threads.
- Local embeddings default to a symbol batch of 32, concurrency 1, and ONNX
  intra-op threads equal to `os.availableParallelism()`.
- Explicitly pinned tiers currently bypass preset application in
  `loadConfig()`. This conflicts with the documented ability to pin a tier.
- The shipped example config explicitly sets concurrency 1 and symbol batch
  32. Those values correctly override presets, but users who copied the
  example cannot receive tier-derived embedding defaults until they remove the
  two fields.
- FileSummary embeddings use a separate conservative batch size of 4 because
  their payloads are substantially longer than symbol payloads.

## Measured Evidence

The first reproducible run used `onnxruntime-node@1.24.3`, the shipped
quantized Jina model, native tokenization, tensor construction, ONNX inference,
masked mean pooling, and L2 normalization over 192 deterministic source
excerpts. It invalidated the earlier exploratory estimate and correctly failed
the 15% gate:

| Width | Existing shape (`batch=32`, `concurrency=1`) | Scaled shape (`batch=16`, `concurrency=threads=width`) | Throughput gain |
|------:|---------------------------------------------:|------------------------------------------------------:|----------------:|
| 2     | 7.27 texts/s | 8.07 texts/s | 10.93% |
| 4     | 10.90 texts/s | 11.94 texts/s | 9.60% |
| 6     | 12.27 texts/s | 13.85 texts/s | 12.83% |
| 8     | 13.08 texts/s | 14.13 texts/s | 8.03% |

The benchmark must therefore search a small, explicit candidate set rather
than publish the unproven `batch=16, concurrency=8` shape. Each shape runs in
its own child process so its peak RSS is not contaminated by an earlier ONNX
session. The accepted width-8 shape must improve median throughput by at least
15% while keeping peak RSS within the larger of 10% or 128 MiB above the
current baseline.

The initial isolated three-warm-run revision appeared to select the
ample-memory shape:

| Width-8 shape | Median | Throughput | Peak RSS | Uplift |
|---------------|-------:|-----------:|---------:|-------:|
| baseline: batch 32, concurrency 1, arena on | 14,664.61 ms | 13.09 texts/s | 3,003.2 MiB | - |
| batch 32, concurrency 8, arena on | 14,710.15 ms | 13.05 texts/s | 3,054.0 MiB | -0.31% |
| batch 16, concurrency 8, arena on | 12,714.09 ms | 15.10 texts/s | 1,447.6 MiB | 15.34% |
| batch 16, concurrency 8, arena off | 26,617.17 ms | 7.21 texts/s | 973.9 MiB | -44.91% |

An independent review run did not reproduce the throughput gate: the same
batch-16 production shape reached 14.75 texts/s against a 12.96 texts/s
baseline, a 13.79% uplift. Its 1,667.4 MiB peak RSS remained below the 3,305.8
MiB limit, but throughput failed the required 15% gate. The shape is therefore
not accepted for production. Disabling the arena remains rejected because its
large wall-time regression conflicts with the minimum-wall-time objective.

The remediation replaces three warm measurements inside one child with three
fresh child processes per shape. Each child performs one warm-up and one
measured pass. The parent aggregates median throughput and uses the worst
candidate peak RSS against the median baseline peak RSS plus
`max(10%, 128 MiB)`. This bounds process-start and allocator-state variance
without adding timing assertions to CI.

The full probe keeps the existing baseline and arena-off comparison, and
evaluates arena-on width-8 batches 8, 12, 16, 20, and 24. It reports all
alternatives, but pass/fail is bound to the exact production shape derived
from the built preset rather than whichever experimental candidate happens to
be fastest. If no candidate repeatedly clears both gates, automatic tuning
reverts to the prior baseline instead of weakening the 15% requirement.

For this benchmark, the complete CPU session tuple is provider `cpu`, intra-op
threads 8, inter-op threads 1, sequential execution, CPU arena enabled, memory
pattern enabled, and graph optimization `all`. The production shape adds the
built ample-memory preset's batch size and concurrency to that tuple. The
control baseline is the same session tuple with batch 32 and concurrency 1;
the no-qualifier fallback is exactly that control tuple. Arena-off remains an
observational memory control and can never be selected for production.

Candidate handoff is explicit: run the sweep, choose the fastest candidate
that clears both gates, update only the ample-memory batch/concurrency preset,
rebuild `dist`, and rerun the complete probe. The second run derives its
production shape from the rebuilt preset and must pass using that exact shape
before documentation may claim the optimization. If no candidate qualifies,
restore the control batch/concurrency, remove the unproven speedup claim, and
report that the preset was withheld rather than treating another shape as a
pass.

These measurements establish a CPU-inference default, not total index wall
time. A disposable full-index A/B remains a separate verification step that
requires explicit index-refresh authorization.

## Design

### Derived embedding width

Derive one bounded embedding width from the existing `CpuProfile`:

```text
embeddingWidth = min(
  MAX_EMBEDDING_CONCURRENCY,
  max(1, physicalCores ?? ceil(logicalCores / 2)),
)
```

`MAX_EMBEDDING_CONCURRENCY` is currently 8. This implements the approved
single-CCD-width ceiling without attempting to detect CCD topology. With the
existing physical-core estimate, the detected tiers resolve approximately as
follows:

| Tier | Logical cores | Derived embedding width |
|------|---------------|-------------------------|
| `mid` | 1-8 | 1-4 |
| `high` | 9-20 | 5-8 |
| `extreme` | 21+ | 8 |

The fallback keeps odd logical-core counts within the same approximate
physical-core bands as even SMT counts; for example, seven logical cores
resolve to width four rather than seven. The physical-core value remains a
best-effort heuristic. Explicit semantic settings are the escape hatch for
no-SMT, heterogeneous ARM, virtualized, or otherwise misreported hosts.

### Tier-owned semantic defaults

When the corresponding field is not explicitly configured, every detected or
pinned tier receives:

```text
semantic.embeddingBatchSize       = freeMemoryGiB < 4 ? 8 : measuredDefaultBatchSize
semantic.embeddingConcurrency     = min(embeddingWidth, memoryWidth)
semantic.onnx.intraOpNumThreads    = embeddingWidth
```

The final ample-memory batch is selected from the revised throughput/RSS
benchmark. Candidate concurrency remains equal to CPU width; production free
memory may lower it but never raises it beyond that bound.

### Free-memory bound

Read `os.freemem()` once beside CPU detection in `loadConfig()`. Convert it to
a small pure memory profile passed to `resolvePerformancePresets`; do not poll
memory during inference or change settings mid-refresh.

The initial policy is intentionally simple and testable:

```text
memoryWidth = clamp(floor(freeMemoryGiB), 1, 8)
embeddingConcurrency = min(embeddingCpuWidth, memoryWidth)
embeddingBatchSize = freeMemoryGiB < 4 ? 8 : measuredDefaultBatchSize
```

This leaves roughly one GiB of currently free memory per concurrent inference
call and gives explicitly configured values final authority. The benchmark may
reduce the ample-memory batch if the accepted wall-time/RSS shape requires it;
it must not add a runtime calibrator or dependency.

The CPU execution path explicitly enables ONNX memory patterns and full graph
optimization. The fastest candidate satisfying the RSS limit determines one
global CPU-memory-arena setting; profile-specific arena behavior is not added
without separate evidence. Unsupported Node binding controls such as shared
allocators, global thread pools, affinity, spinning configuration, and
mimalloc remain out of scope because they require a custom ONNX Runtime build.

The design deliberately does not change:

- `semantic.fileSummaryEmbeddingBatchSize` (remains 4),
- `semantic.onnx.interOpNumThreads` and `semantic.onnx.executionMode` (retain
  their existing schema defaults unless explicitly configured),
- execution-provider selection,
- model or model variant selection,
- multi-model sequencing, or
- deterministic retrieval sessions.

### Preset application and override order

`loadConfig()` will always resolve an effective tier:

1. Detect the CPU profile once.
2. Use the detected tier when `performanceTier` is `auto`; otherwise use the
   explicitly pinned tier.
3. Resolve tier presets using the CPU profile and the raw pre-Zod config.
4. Apply preset values only where the raw config omitted the field.

This fixes pinned-tier behavior at the shared preset boundary. Explicit values
under `semantic`, including nested `semantic.onnx` fields, continue to win.
Pinning a tier selects that tier's other presets but does not invent CPU
topology: embedding width still comes from the detected physical-core estimate.
Users who intentionally want a different width set the semantic fields
explicitly.
An explicit `intraOpNumThreads: 0` therefore remains authoritative and keeps
the existing runtime-auto behavior. Existing configs opt into the new defaults
by removing explicit `embeddingBatchSize`, `embeddingConcurrency`, and
`onnx.intraOpNumThreads` fields rather than changing `performanceTier`.

## Implementation Boundaries

The minimum implementation should touch only:

- CPU preset resolution and config loading,
- focused config/preset tests, and
- one reproducible, non-CI CPU embedding benchmark script, and
- public configuration and semantic-embedding documentation.

No new dependency, CPU model allowlist, continuously adaptive runtime
autotuner, custom ONNX Runtime build, model artifact, or index lifecycle change
is needed.

## Test and Verification Strategy

Implementation follows test-first development:

1. Add failing tests for derived widths at representative core counts.
2. Cover `mid`, `high`, and `extreme`, including odd logical counts, an
   undefined physical estimate, and the eight-core cap.
3. Add failing config-loading tests for auto-detected and explicitly pinned
   tiers.
4. Prove partial nested ONNX configuration and explicit
   `intraOpNumThreads: 0` override only their corresponding derived fields.
5. Prove explicit `embeddingBatchSize`, `embeddingConcurrency`, and
   `fileSummaryEmbeddingBatchSize` values win; prove the omitted FileSummary
   batch remains 4 and existing non-semantic preset overrides remain unchanged.
   Then implement the smallest preset/config changes that pass.

Wall-clock assertions do not belong in the unit suite because scheduler and
host variance would make them flaky. The measured probe is verification
evidence, while deterministic tests protect the configuration contract.

Use `scripts/benchmark-cpu-embedding-tiers.mjs` as the reproducible manual
probe. It compares the existing shape with the bounded batch sweep and the
CPU-arena control using the installed quantized Jina model and length-sorted
SDL-MCP source excerpts. A full run executes three fresh child processes per
shape; each child warms once, measures once, releases its session, and reports
throughput plus `process.resourceUsage().maxRSS`.

```powershell
node scripts/benchmark-cpu-embedding-tiers.mjs
```

The verification pass condition on the 9950X3D is that the exact built
production shape has median width-8 throughput at least 15% higher than the
existing shape across three fresh processes. It qualifies when its worst
`candidateKiB <= medianBaselineKiB + max(medianBaselineKiB * 0.10,
128 * 1024)`. Experimental candidates are ranked for selection evidence but
cannot make the command pass. The script is manual and must not introduce
timing or RSS assertions into CI.

The parent accepts exactly three valid samples for every full-run shape. A
child spawn error, signal or nonzero exit, missing record, mismatched shape ID,
malformed JSON, or non-finite/non-positive timing, throughput, or RSS fails the
entire command. It never aggregates a surviving subset. The aggregation and
gate rules have deterministic unit coverage using synthetic records; only the
real performance threshold remains manual.

Config-loading integration coverage mocks only `node:os.freemem()` while
exercising the real loader. It proves exact results below and at the 4 GiB
boundary and proves the first resolved free-memory snapshot remains stable for
the lifetime of a cached configuration. One uncached load samples free memory
exactly once; cache hits do not sample it again. Pure preset tests continue to
own the full boundary matrix.

## Documentation

Update the CPU preset table, configuration reference, semantic embedding setup
guide, and generated configuration schema descriptions so they agree on:

- the measured ample-memory symbol batch and batch 8 below 4 GiB free,
- concurrency bounded by physical-core width and whole GiB of free memory,
- physical-core-derived ONNX intra-op width capped at 8,
- FileSummary batch size remaining 4,
- explicit override precedence, and
- pinned tiers applying their presets.

Remove explicit `embeddingConcurrency` and `embeddingBatchSize` values from
the shipped example config so new copied configs inherit tier-derived values.
Keep the Zod/schema fallback defaults for validation compatibility, but label
them as schema fallbacks that are superseded when tier presets resolve omitted
fields. Document that existing users opt in by deleting their explicit values.
Add an Unreleased `CHANGELOG.md` Changed entry covering the automatic CPU/free-
memory defaults, pinned-tier behavior, explicit-override precedence, and the
remove-explicit-fields migration step.

## Success Criteria

- The 9950X3D auto-detects as `extreme`; ample free memory selects the measured
  width-8 batch/concurrency shape while retaining inter-op 1 and sequential
  execution.
- Lower detected core counts scale concurrency and intra-op threads to the
  estimated physical-core count, capped at 8.
- Lower free-memory snapshots reduce automatic concurrency and, below 4 GiB,
  symbol batch size; the snapshot is stable for the lifetime of the loaded
  configuration.
- Pinned tiers apply presets instead of silently retaining schema defaults.
- Explicit semantic settings remain byte-for-byte authoritative.
- FileSummary embeddings retain batch 4 while using the derived concurrency.
- Focused tests, typecheck, build, and documentation checks pass.
- The exact production shape, not an arbitrary experimental winner, meets the
  documented 15% width-8 improvement gate and the 10%/128 MiB peak-RSS
  guardrail across three fresh processes on the 9950X3D. If none does, the
  prior automatic baseline remains production behavior. Total index wall-time
  acceptance is reported only after a separately authorized, disposable
  full-index A/B.
