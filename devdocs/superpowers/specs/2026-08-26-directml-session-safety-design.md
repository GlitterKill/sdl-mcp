# DirectML Session Safety Design

**Date:** 2026-08-26

**Status:** Approved for implementation planning

## Goal

Make SDL-MCP's local ONNX embedding path comply with DirectML's session contract while preserving concurrent tokenization and the existing throughput behavior of other execution providers.

## Problem

SDL-MCP currently accepts `executionMode: "parallel"` for DirectML, leaves ONNX memory-pattern optimization enabled, and permits multiple embedding workers to call `Run()` concurrently on one cached DirectML session. ONNX Runtime requires DirectML sessions to use sequential graph execution, disable memory-pattern optimization, and admit only one `Run()` call at a time.

The failure reproduced after a large Nomic workload: the first Jina `Run()` terminated the Node.js process without a JavaScript error. CPU inference and a second DirectML adapter remained functional. The fix must enforce the provider contract before another full index attempt.

## Design

`resolveEmbeddingSessionOptions()` remains the single policy boundary for provider-specific ONNX settings. After resolving the supported provider list, it detects whether DirectML is present and returns these effective settings:

- DirectML: `executionMode: "sequential"`, `enableMemPattern: false`, and serialized session runs.
- Other providers: preserve the configured execution mode, keep memory patterns enabled, and retain concurrent session runs.
- Deterministic retrieval: preserve the existing single-threaded sequential CPU profile.

`createOnnxSessionInternal()` passes the effective memory-pattern setting to `InferenceSession.create()`. For a DirectML session, it also creates one existing `ConcurrencyLimiter` with `maxConcurrency: 1`.

`runBatchInference()` keeps tokenization, tensor construction, and result processing outside the limiter. The limiter wraps only `session.run(feeds)`. This preserves the useful overlap from `semantic.embeddingConcurrency` while preventing concurrent DirectML dispatch through one cached session.

Export `runBatchInference()` as `@internal` so the focused unit test can inject a fake session, tokenizer, tensor constructor, and shared limiter. This exposes the existing boundary for testing without adding a production abstraction or runtime hook.

The change does not select a different GPU adapter. Adapter selection and discrete-GPU driver diagnosis remain separate work.

## Error handling

The limiter releases its slot when `session.run()` resolves or rejects, using the existing `ConcurrencyLimiter` behavior. The fix does not attempt an in-process DirectML fallback because the observed native termination bypasses JavaScript error handling.

## Tests

Use the existing embedding execution-provider unit suite.

1. Add a failing policy test proving that DirectML overrides configured parallel execution, disables memory patterns, and requests serialized runs.
2. Add a non-DirectML policy test proving that CPU throughput settings remain unchanged.
3. Add focused `runBatchInference()` tests with a fake session and tokenizer. The DirectML case starts concurrent batches and asserts that tokenization overlaps while `Run()` never does. The CPU case omits the limiter and asserts that `Run()` calls can overlap, protecting existing non-DirectML throughput.
4. Build before running tests because the unit suite imports `dist`.
5. Run the indexer harness and typecheck after the focused tests pass.

The hardware probe remains database-free. A full index requires separate explicit authorization.

## Documentation

Update the semantic embedding setup guide and configuration reference. State that SDL-MCP overrides DirectML graph execution to sequential mode, disables memory patterns, and serializes calls per cached session even when `embeddingConcurrency` is greater than one. Explain that higher concurrency can still overlap tokenization.

## Non-goals

- Do not add DirectML device selection.
- Do not change CPU, CUDA, TensorRT, CoreML, or WebGPU concurrency.
- Do not change embedding batch sizes or model variants.
- Do not run an index refresh.
- Do not add a dependency or a new concurrency abstraction.

## Completion criteria

The task is complete when focused regression tests, the indexer harness, typecheck, and a database-free DirectML probe confirm the safe session configuration and serialized dispatch. If adapter 0 still fails after the code change, report the hardware/runtime limitation separately; do not weaken the DirectML safety contract.
