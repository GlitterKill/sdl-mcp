# GPU-Aware Jina FP16 Default Design

**Date:** 2026-08-28
**Status:** User-approved; ready for implementation planning

## Objective

Install both supported Jina ONNX artifacts and make SDL-MCP's automatic model
selection match the execution path. DirectML indexing uses FP16, while CPU and
deterministic query sessions use the quantized model. Existing explicit model
variant settings remain authoritative.

The change must not start the HTTP server, refresh an index, or mutate the
current graph database. Global activation updates the installed package, model
cache, and current configuration only.

## Evidence and Constraints

- ONNX Runtime CPU execution does not support general Float16 operators. A
  global FP16 default therefore breaks CPU-only and deterministic sessions.
- SDL-MCP currently forces deterministic sessions to CPU with sequential
  execution and one intra/inter-op thread.
- DirectML requires sequential execution and disabled memory patterns. The
  existing session-option resolver already owns those provider constraints.
- The pinned Jina registry maps `default` and `int8` to
  `model_quantized.onnx`, and `fp16` to `model_fp16.onnx`.
- The postinstall script currently fetches only the quantized Jina graph.
- Persisted symbol and file-summary cache hashes do not include the effective
  model variant. Changing variants without fixing that identity could reuse or
  mix incompatible vectors.
- A JavaScript fallback can recover from an ONNX session-creation error. It
  cannot recover from a fatal native process termination; worker-process
  isolation is out of scope unless FP16 DirectML also proves unstable.

## Behavior Contract

The existing `semantic.modelVariant` field keeps its public shape. Omission or
the literal value `default` selects automatic mode for Jina. Any other value is
an explicit override and follows the existing registry validation.

| Jina request | Runtime context | Effective graph and provider |
|--------------|-----------------|------------------------------|
| automatic | non-deterministic, provider order starts with `dml,cpu` | FP16 on the configured DirectML-leading path; quantized CPU is the session-creation fallback |
| automatic | non-deterministic, provider order starts with `dml` but CPU is not second | FP16 on the configured DirectML-leading path; no automatic variant fallback |
| automatic | non-deterministic CPU path | quantized on CPU |
| automatic | deterministic query or prewarm | quantized on the existing forced-CPU path |
| explicit variant | any path | requested registry variant with existing provider behavior; no hidden variant substitution |

DirectML acceleration is the only automatic GPU path in this change because it
is the validated Windows provider. CUDA, CoreML, and other provider-specific
defaults need their own evidence before they select FP16 automatically. Nomic
selection and artifacts remain unchanged.

Provider order remains meaningful. A configuration that puts CPU first stays
on the quantized CPU path. Automatic DirectML fallback requires CPU to be the
immediate next provider, so `dml,cpu` is eligible, while `dml`,
`dml,cuda,cpu`, and other non-adjacent orders are not. The FP16 DirectML
attempt still uses the configured provider list; if that session fails without
an eligible CPU fallback, provider creation fails through the existing caller
contract. The implementation does not add, skip, or reorder configured
providers.

## Runtime Design

Add the minimum provider-aware resolution to the existing model registry and
local embedding construction path. Do not add a hardware detector, factory
hierarchy, or new configuration field.

The existing model registry owns one pure, private resolution contract. Its
inputs are model name, requested variant, deterministic mode, and normalized
execution-provider order. Its ordered output contains, for each candidate, the
canonical registry variant and exact session provider list. Automatic
`dml,cpu` produces an FP16 candidate followed by a quantized CPU candidate;
automatic DML without adjacent CPU and every explicit variant produce one
candidate.

The local embedding constructor owns candidate iteration and ONNX session
creation. It returns only after one session is initialized, exposing:

- the provider used for embedding calls;
- a cache-compatibility key containing model name and canonical artifact
  variant; and
- a diagnostic identity containing model, variant, and concrete provider list.

The indexer constructs this initialized provider before checking cached symbol
or file-summary rows, then passes only the cache-compatibility key to the
existing hash builder. The diagnostic identity is for logs and acceptance
assertions. The embedding provider owns later inference calls and never changes
candidates after initialization.

The runtime resolves an ordered candidate list before cache comparison:

1. Resolve automatic or explicit variant intent.
2. Apply deterministic CPU constraints before choosing the Jina artifact.
3. For automatic `dml,cpu` indexing, try an FP16 DirectML session first.
4. If ONNX returns a session-creation error, try one quantized CPU session.
5. Expose the successfully initialized candidate's cache-compatibility key and
   separate diagnostic identity.

The indexer computes cache hits only after that identity is final. A quantized
fallback must never carry an FP16 cache hash. If no candidate initializes, the
existing degraded-provider behavior may serve deterministic mock vectors to
non-persistence callers, but embedding refresh continues to reject mock vectors
and must not write them to LadybugDB.

Fallback is intentionally limited to session creation before any vector write.
A later JavaScript-visible inference error fails that model pass rather than
switching variants after partial persistence. A fatal native crash remains
non-recoverable in-process and fails acceptance.

Logs identify the selected provider and effective variant and record a bounded
warning when automatic fallback occurs. MCP response contracts gain no timing,
machine path, provider, or session fields.

## Cache Identity and Migration

Include the Jina cache-compatibility key in the existing content/card hash for
both symbol and file-summary embeddings. Keep the current embedding row IDs and
LadybugDB schema; no migration table or new index is needed. Other model hashes,
including Nomic, remain unchanged in this scoped change.

The cache-compatibility key uses model name and canonical resolved registry
variant, not the raw alias or execution provider. For example, aliases that
resolve to the same quantized artifact share one key, and the same quantized
artifact can reuse rows across CPU and DirectML execution. Automatic FP16 and
automatic quantized runs have different keys. Provider details remain in the
diagnostic identity and never invalidate compatible cached vectors.

Existing Jina rows lack the compatibility-key component and therefore become
stale the next time semantic indexing is explicitly run under the new build.
This deliberate one-time Jina rebuild prevents a partially quantized, partially
FP16 index without unnecessarily invalidating Nomic rows. Installation and
configuration changes do not trigger that rebuild.

Switching the same database between automatic DirectML and CPU indexing also
invalidates semantic cache rows. That cost is preferable to silently mixing
embedding spaces. Deterministic queries may use quantized Jina against an
FP16-built index only after the cross-variant acceptance probe passes.

## Model Installation

Extend the existing pinned postinstall manifest with both Jina graphs:

- `model_fp16.onnx`
- `model_quantized.onnx`

Each artifact keeps a pinned Hugging Face revision and SHA-256 digest. Reuse the
existing cache directory, downloader, temporary-file handling, and checksum
verification. Do not bundle either model in the npm package and do not add a
dependency.

Normal postinstall keeps its current best-effort offline behavior. The explicit
global activation step is stricter: it verifies that both Jina graphs and their
shared tokenizer/config assets exist and match the pinned digests before it
reports success.

The current global package must be replaced with a built copy of this checkout,
not a symlink. The active configuration then omits `modelVariant` and sets the
provider order to `dml,cpu`, which activates automatic FP16 indexing and the
quantized CPU fallback. The configured graph path remains unchanged.

## Failure Handling

- Missing or corrupt artifacts use the existing verified download path; strict
  global activation fails if verification still cannot succeed.
- An automatic FP16 DirectML session-creation error logs one warning and retries
  quantized CPU once only when CPU is the immediate next configured provider.
- DML-only and non-adjacent CPU orders have no automatic variant fallback and
  return the existing provider-creation failure if the FP16 session fails.
- An explicit `fp16` request never changes silently to quantized; it returns the
  existing typed failure or degraded result according to the caller contract.
- A failed model pass writes no mock vectors and never changes cache identity to
  claim a variant that did not execute.
- A fatal native DirectML termination fails the child-process acceptance probe
  and blocks the configuration change. The active CPU configuration remains
  untouched, so no in-process rollback is needed. Recovering during production
  indexing would require a separately designed worker-process boundary.

## Test-First Implementation

Use the existing Node test runner and current provider/session test seams.

1. Add a table-driven unit test for automatic Jina selection across
   deterministic CPU, CPU-only, ordered `dml,cpu`, DML-only, non-adjacent CPU,
   CPU-first, and explicit variant cases.
2. Add one fallback test that makes FP16 DirectML session creation throw and
   proves quantized CPU becomes the final identity before persistence. Prove an
   explicit FP16 request does not substitute variants.
3. Add cache tests proving the canonical effective variant changes symbol and
   file-summary hashes while aliases for one artifact do not.
4. Extend postinstall tests around the existing downloader boundary to require
   both pinned Jina graphs and reject a bad digest without downloading models in
   CI.
5. Update focused config, generated-schema, documentation, and changelog checks.

No wall-clock assertion belongs in CI. The implementation should run focused
tests first, then typecheck, lint, build, and the relevant documentation checks.

## Database-Free Acceptance

Run acceptance against the built global copy without opening the configured
LadybugDB:

1. Verify both cached Jina graph files against their pinned SHA-256 digests.
2. Create an automatic `dml,cpu` non-deterministic provider and prove it reports
   FP16/DirectML and returns finite, normalized 768-dimensional vectors.
3. Create an automatic deterministic provider and prove it reports
   quantized/CPU, returns the same shape, and repeats byte-stably.
4. Force a recoverable DirectML session-creation error and prove the automatic
   path selects quantized/CPU rather than mock; prove explicit FP16 does not.
5. Reuse the existing deterministic semantic fixture for an in-memory
   cross-variant retrieval probe. Embed corpus documents with FP16 DirectML and
   queries with deterministic quantized CPU, then rank the FP16 corpus with the
   quantized query vectors. Every paired same-text FP16/quantized vector must
   have cosine similarity of at least 0.99, and every existing expected target
   must remain inside its required top-k result. Run the existing all-quantized
   query/corpus topology as the control.

The probe reports CPU and DirectML inference wall times but makes no speed claim
or timing gate. Total index wall time remains a separate, explicitly authorized
full-index acceptance run.

## Documentation and Configuration

Update the semantic embedding setup guide, semantic engine deep dive,
configuration reference/schema/example, architecture notes where the runtime
choice is described, and the Unreleased changelog. The documentation must state:

- `default` is provider-aware for Jina rather than a fixed artifact;
- DirectML automatic indexing uses FP16 only when DirectML leads the configured
  provider order;
- automatic quantized CPU fallback requires the adjacent provider order
  `dml,cpu`;
- deterministic and CPU execution use quantized Jina;
- explicit variants override automatic selection;
- both artifacts are installed and verified; and
- changing the effective indexing variant invalidates semantic cache rows and
  requires a separately initiated semantic rebuild.

Documentation edits must preserve the unrelated retained-HNSW work already in
the dirty worktree. Generated config artifacts must be rebuilt through their
existing scripts rather than edited independently.

## Activation Sequence

1. Implement and pass focused tests plus build/documentation gates.
2. Install the built package globally as a copy and strictly verify both Jina
   artifacts. Keep the active CPU configuration unchanged.
3. Run the database-free DirectML, CPU, fallback, determinism, and quality
   probes in child processes with explicit probe settings. A fatal DirectML
   termination therefore cannot alter the active configuration.
4. Only after every probe passes, atomically replace the current configuration
   with the `dml,cpu` automatic settings while preserving its graph database
   path and unrelated fields. Read the file back and validate the effective
   configuration.
5. Leave the HTTP server stopped and do not run `index.refresh` or `sdl-mcp
   index`. If any earlier step fails, stop with the original CPU configuration
   still active.

Rollback requires only restoring CPU-first providers or an explicit quantized
variant. The extra cached FP16 artifact is harmless and can remain installed.

## Success Criteria

- A fresh or updated global installation has verified FP16 and quantized Jina
  artifacts at the pinned revision.
- Automatic `dml,cpu` indexing initializes FP16 DirectML; deterministic and CPU
  paths initialize quantized CPU.
- Recoverable automatic DirectML initialization failure selects quantized CPU
  before cache lookup or persistence.
- Explicit variant behavior remains unchanged.
- Symbol and file-summary cache identities prevent cross-variant reuse without
  a LadybugDB schema change.
- Database-free vector, determinism, cross-variant quality, build, focused test,
  and documentation checks pass.
- The active graph path is unchanged, the graph is not refreshed, and the HTTP
  server remains stopped.
