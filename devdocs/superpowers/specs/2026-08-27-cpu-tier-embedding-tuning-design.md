# CPU-Tier Embedding Tuning Design

**Date:** 2026-08-27
**Status:** Approved for implementation planning

## Objective

Reduce local CPU embedding wall time by extending SDL-MCP's existing CPU-tier
presets to cover symbol embedding batch width, embedding concurrency, and ONNX
Runtime thread settings. The defaults must scale from small CPUs through the
`extreme` tier while preserving explicit user configuration.

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

The read-only probe used `onnxruntime-node@1.24.3`, the shipped quantized Jina
model, native tokenization, tensor construction, ONNX inference, masked mean
pooling, and L2 normalization. Inputs were length-sorted excerpts sampled from
SDL-MCP source files.

| Width | Existing shape (`batch=32`, `concurrency=1`) | Scaled shape (`batch=16`, `concurrency=threads=width`) | Throughput gain |
|------:|---------------------------------------------:|------------------------------------------------------:|----------------:|
| 2     | 31.67 texts/s | 39.41 texts/s | 24% |
| 4     | 50.01 texts/s | 67.66 texts/s | 35% |
| 6     | 59.71 texts/s | 80.99 texts/s | 36% |
| 8     | 67.28 texts/s | 89.75 texts/s | 33% |

On the 9950X3D, the proposed extreme settings reached approximately 90 texts/s
versus 64-67 texts/s for the current effective defaults. A separate Nomic
FileSummary probe showed 9.57 texts/s at batch 4, concurrency 8, and eight
intra-op threads versus 9.21 texts/s at batch 4, concurrency 1, and 16 intra-op
threads. Nomic batch sizes 8 and 16 were slower, so the FileSummary batch
remains unchanged while it shares the tier-derived concurrency.

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
semantic.embeddingBatchSize       = 16
semantic.embeddingConcurrency     = embeddingWidth
semantic.onnx.intraOpNumThreads    = embeddingWidth
```

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

No new dependency, CPU model allowlist, runtime autotuner, model artifact, or
index lifecycle change is needed.

## Test and Verification Strategy

Implementation follows test-first development:

1. Add failing tests for derived widths at representative core counts.
2. Cover `mid`, `high`, and `extreme`, including odd logical counts, an
   undefined physical estimate, and the eight-core cap.
3. Add failing config-loading tests for auto-detected and explicitly pinned
   tiers.
4. Prove partial nested ONNX configuration and explicit
   `intraOpNumThreads: 0` override only their corresponding derived fields.
5. Prove FileSummary batch 4 and existing non-semantic preset overrides remain
   unchanged, then implement the smallest preset/config changes that pass.

Wall-clock assertions do not belong in the unit suite because scheduler and
host variance would make them flaky. The measured probe is verification
evidence, while deterministic tests protect the configuration contract.

Add `scripts/benchmark-cpu-embedding-tiers.mjs` as the reproducible manual
probe. It compares the existing shape (`batch=32`, `concurrency=1`) with the
scaled shape (`batch=16`, `concurrency=threads=width`) at widths 2, 4, 6, and 8
using the installed quantized Jina model and length-sorted SDL-MCP source
excerpts:

```powershell
node scripts/benchmark-cpu-embedding-tiers.mjs
```

The verification pass condition on the 9950X3D is a median width-8 scaled
throughput at least 15% higher than the width-8 existing shape over three warm
runs. The script is manual and must not introduce a timing assertion into CI.

## Documentation

Update the CPU preset table, configuration reference, semantic embedding setup
guide, and generated configuration schema descriptions so they agree on:

- symbol batch size 16 for tier-derived defaults,
- physical-core-derived concurrency and ONNX intra-op width capped at 8,
- FileSummary batch size remaining 4,
- explicit override precedence, and
- pinned tiers applying their presets.

Remove explicit `embeddingConcurrency` and `embeddingBatchSize` values from
the shipped example config so new copied configs inherit tier-derived values.
Keep the Zod/schema fallback defaults for validation compatibility, but label
them as schema fallbacks that are superseded when tier presets resolve omitted
fields. Document that existing users opt in by deleting their explicit values.

## Success Criteria

- The 9950X3D auto-detects as `extreme` and resolves symbol embedding settings
  to batch 16, concurrency 8, and intra-op threads 8 while retaining the
  existing inter-op and execution-mode defaults.
- Lower detected core counts scale concurrency and intra-op threads to the
  estimated physical-core count, capped at 8.
- Pinned tiers apply presets instead of silently retaining schema defaults.
- Explicit semantic settings remain byte-for-byte authoritative.
- FileSummary embeddings retain batch 4 while using the derived concurrency.
- Focused tests, typecheck, build, and documentation checks pass.
- The manual benchmark meets the documented 15% width-8 improvement gate on
  the 9950X3D. Total index wall-time acceptance is reported only after a
  separately authorized, disposable full-index A/B.
