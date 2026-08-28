# GPU-Aware Jina FP16 Default Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install both Jina ONNX graphs, select FP16 for automatic DirectML indexing and quantized Jina for deterministic or CPU execution, prevent cross-variant cache reuse, and activate the verified global installation without touching the graph database.

**Architecture:** Add one pure candidate resolver to the existing model registry and let the existing ONNX session boundary try those candidates before returning an initialized identity. Symbol and FileSummary persistence append the resolved Jina artifact identity to their existing hashes, while retrieval keeps deterministic quantized CPU sessions. The existing postinstall cache, provider policy, and model registry remain the only artifact and runtime owners.

**Tech Stack:** TypeScript, Node.js 24 `node:test`, ONNX Runtime Node.js 1.24.3, native `tokenizers`, PowerShell, existing model cache and postinstall scripts.

---

**Approved spec:** `devdocs/superpowers/specs/2026-08-28-gpu-aware-jina-fp16-default-design.md`

**Required implementation skills:** `@test-driven-development`, `@subagent-driven-development`, `@verification-before-completion`, and `@test-scope`.

## Baseline constraints

- The HTTP server stays stopped. Do not run `index.refresh`, `sdl.workflow` indexing, `sdl-mcp index`, or any command that opens the configured LadybugDB.
- Preserve the current retained-HNSW worktree changes. `src/indexer/embeddings.ts`, `tests/unit/semantic-pipeline-regressions.test.ts`, `CHANGELOG.md`, and several target docs are already modified; inspect and stage only this feature's hunks.
- Build `dist` before focused tests that import compiled modules.
- Keep `semantic.modelVariant` as the existing optional string. Omitted and literal `default` are automatic only for Jina; no new config field or dependency is allowed.
- Keep the existing execution-provider normalization, including its final CPU session provider. Variant fallback eligibility uses the raw normalized configured order: only adjacent `dml,cpu` produces a second quantized candidate.
- Keep Nomic selection and persisted hashes unchanged. Do not change LadybugDB schema, row IDs, vector property names, HNSW lifecycle, or MCP response contracts.
- Use the cached FP16 artifact's verified SHA-256 `1aafc4fcd63d2e6899e88402ff731e7c646c2e435048294a3cbc908a40d45d7c` and the existing pinned Jina revision `516f4baf13dec4ddddda8631e019b5737c8bc250`.
- Commit locally only. Do not push. Before each commit, run `git diff --cached --check` and confirm the staged name list excludes pre-existing HNSW hunks.

## File map

- Modify `src/indexer/model-registry.ts`: resolve ordered automatic/explicit Jina candidates and canonical artifact cache keys.
- Modify `src/indexer/embeddings-local.ts`: include candidate identity in session caching, try the adjacent CPU candidate once, and return the initialized identity.
- Modify `src/indexer/embeddings.ts`: initialize local providers before persistence and add the Jina artifact key to Symbol hashes.
- Modify `src/indexer/file-summary-embeddings.ts`: initialize providers before cache inspection and add the same key to Jina FileSummary hashes.
- Modify `src/retrieval/orchestrator.ts` and `src/live-index/overlay-embedding-cache.ts`: initialize before checking fallback state; deterministic retrieval remains CPU/quantized.
- Modify `scripts/postinstall-models.mjs`: install and strictly verify both pinned Jina ONNX files.
- Create `scripts/jina-gpu-aware-probe-contract.mjs` and `scripts/probe-jina-gpu-aware-default.mjs`: isolate real CPU/DirectML sessions and evaluate cross-variant quality without a database.
- Modify focused tests under `tests/unit/`: cover selection, fallback, cache invalidation, installer provenance, and probe validation.
- Update `src/config/types.ts`, `config/sdlmcp.config.schema.json`, `src/indexer/AGENTS.md`, `docs/configuration-reference.md`, `docs/architecture.md`, both semantic deep dives, and `CHANGELOG.md`.
- Operationally update `F:\Claude\sdl-mcp\sdlmcp.config.json` only after the global probes pass; preserve its graph path and all unrelated fields.

## Chunk 1: Provider-aware model and session lifecycle

### Task 1: Specify automatic Jina candidates

**Files:**

- Modify: `tests/unit/model-registry.test.ts`
- Modify: `src/indexer/model-registry.ts:1-260`

- [ ] **Step 1: Add the failing candidate table**

Import `resolveEmbeddingModelCandidates` and add a table-driven test with these exact cases:

```typescript
const JINA = "jina-embeddings-v2-base-code";

const cases = [
  {
    name: "automatic DirectML with adjacent CPU",
    input: {
      name: JINA,
      requestedVariant: "default",
      deterministic: false,
      requestedProviders: ["dml", "cpu"],
    },
    expected: [
      ["fp16", "model_fp16.onnx", ["dml", "cpu"]],
      ["default", "model_quantized.onnx", ["cpu"]],
    ],
  },
  {
    name: "automatic deterministic query",
    input: {
      name: JINA,
      requestedVariant: undefined,
      deterministic: true,
      requestedProviders: ["dml", "cpu"],
    },
    expected: [["default", "model_quantized.onnx", ["cpu"]]],
  },
  {
    name: "automatic CPU",
    input: {
      name: JINA,
      requestedVariant: undefined,
      deterministic: false,
      requestedProviders: ["cpu"],
    },
    expected: [["default", "model_quantized.onnx", ["cpu"]]],
  },
  {
    name: "CPU-first remains quantized and preserves provider order",
    input: {
      name: JINA,
      requestedVariant: undefined,
      deterministic: false,
      requestedProviders: ["cpu", "dml"],
    },
    expected: [["default", "model_quantized.onnx", ["cpu", "dml"]]],
  },
  {
    name: "DirectML without configured CPU",
    input: {
      name: JINA,
      requestedVariant: undefined,
      deterministic: false,
      requestedProviders: ["dml"],
    },
    expected: [["fp16", "model_fp16.onnx", ["dml"]]],
  },
  {
    name: "non-adjacent CPU does not become a variant fallback",
    input: {
      name: JINA,
      requestedVariant: undefined,
      deterministic: false,
      requestedProviders: ["dml", "cuda", "cpu"],
    },
    expected: [["fp16", "model_fp16.onnx", ["dml", "cuda", "cpu"]]],
  },
  {
    name: "explicit FP16 remains explicit on deterministic CPU",
    input: {
      name: JINA,
      requestedVariant: "fp16",
      deterministic: true,
      requestedProviders: ["dml", "cpu"],
    },
    expected: [["fp16", "model_fp16.onnx", ["cpu"]]],
  },
  {
    name: "Nomic keeps its existing default",
    input: {
      name: "nomic-embed-text-v1.5",
      requestedVariant: "default",
      deterministic: false,
      requestedProviders: ["dml", "cpu"],
    },
    expected: [["default", "model_quantized.onnx", ["dml", "cpu"]]],
  },
] as const;
```

Map each returned candidate to `[variantName, modelFile, requestedProviders]` before comparing. Add separate assertions that Jina `default` and `int8` produce the same `cacheCompatibilityKey`, while `fp16` differs.

- [ ] **Step 2: Build unchanged source**

Run:

```powershell
npm run build:all
```

Expected: exit `0`.

- [ ] **Step 3: Run the candidate test and observe RED**

Run:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/model-registry.test.ts
```

Expected: FAIL because `resolveEmbeddingModelCandidates` is not exported.

- [ ] **Step 4: Implement the pure resolver**

Add this focused model-registry contract without platform detection or config loading:

```typescript
export interface EmbeddingModelCandidate {
  variantName: string;
  modelFile: string;
  requestedProviders: string[];
  cacheCompatibilityKey?: string;
}

export function resolveEmbeddingModelCandidates(params: {
  name: string;
  requestedVariant?: string;
  deterministic: boolean;
  requestedProviders?: readonly string[];
}): EmbeddingModelCandidate[] {
  const providers = normalizeRequestedProviders(params.requestedProviders);
  const automatic =
    params.requestedVariant === undefined || params.requestedVariant === "default";

  if (params.name === "jina-embeddings-v2-base-code" && automatic) {
    if (params.deterministic || providers[0] !== "dml") {
      return [candidate(params.name, "default", params.deterministic ? ["cpu"] : providers)];
    }
    const primary = candidate(params.name, "fp16", providers);
    return providers[1] === "cpu"
      ? [primary, candidate(params.name, "default", ["cpu"])]
      : [primary];
  }

  const { variantName } = resolveVariant(params.name, params.requestedVariant);
  return [
    candidate(
      params.name,
      variantName,
      params.deterministic ? ["cpu"] : providers,
    ),
  ];
}
```

Keep `normalizeRequestedProviders()` private: lowercase, deduplicate in order, and default an empty/omitted list to `cpu` without platform filtering or automatic append. Build each candidate through `resolveVariant()` and use `${name}:${variant.modelFile}` as `cacheCompatibilityKey` only for Jina. The model filename, rather than the alias, makes `default` and `int8` compatible.

- [ ] **Step 5: Rebuild and verify GREEN**

Run the build and focused test from Steps 2-3.

Expected: both exit `0`; existing `resolveVariant()` behavior remains green.

- [ ] **Step 6: Commit the pure policy**

```powershell
git add src/indexer/model-registry.ts tests/unit/model-registry.test.ts
git diff --cached --check
git commit -m "feat(embeddings): resolve GPU-aware Jina variants"
```

Expected: the commit contains only the registry and its unit test.

### Task 2: Make session creation candidate-aware and cache-safe

**Files:**

- Modify: `src/indexer/embeddings-local.ts:76-420`
- Create: `tests/unit/embedding-session-candidates.test.ts`
- Test: `tests/unit/embeddings-execution-providers.test.ts`

- [ ] **Step 1: Write failing session fallback tests**

Add a test-only loader argument to the planned `createOnnxSession()` contract and specify these behaviors before implementing it:

```typescript
await resetLocalEmbeddingRuntime();
const attempts: string[] = [];
const session = await createOnnxSession(
  "jina-embeddings-v2-base-code",
  {
    modelVariant: "default",
    executionProviders: ["dml", "cpu"],
  },
  async (_model, candidate) => {
    attempts.push(candidate.variantName);
    if (candidate.variantName === "fp16") {
      throw new OnnxSessionCreationError(
        "forced DirectML session creation failure",
      );
    }
    return fakeSession(candidate);
  },
);

assert.deepStrictEqual(attempts, ["fp16", "default"]);
assert.equal(session.variantName, "default");
assert.deepStrictEqual(session.executionProviders, ["cpu"]);
assert.equal(
  session.cacheCompatibilityKey,
  "jina-embeddings-v2-base-code:model_quantized.onnx",
);
```

Add cases proving:

- explicit `fp16` calls the loader once and rejects;
- `dml` and `dml,cuda,cpu` call the FP16 loader once and reject;
- deterministic automatic mode calls only quantized CPU;
- repeating one request reuses its session, while changing variant or provider order does not reuse it;
- disposing a session evicts its exact cache entry so the next identical request invokes the loader again;
- omitted and literal `default` share one canonical automatic-mode cache entry;
- artifact/path/tokenizer and other untyped loader errors reject immediately without a quantized retry;
- when both adjacent automatic candidates throw `OnnxSessionCreationError`, the second error is returned; repeating the request attempts both candidates again, proving rejected-cache cleanup;
- a mocked `logger.warn` records one bounded primary-to-fallback event and a mocked
  `logger.info` records the candidate that actually became active.

- [ ] **Step 2: Build and observe RED**

Run:

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embedding-session-candidates.test.ts tests/unit/embeddings-execution-providers.test.ts
```

Expected: the new file fails because session options, identity fields, and the loader seam do not exist.

- [ ] **Step 3: Extend the session identity and internal options**

Add the resolved fields to `OnnxEmbeddingSession`:

```typescript
variantName: string;
modelFile: string;
executionProviders: readonly string[];
cacheCompatibilityKey?: string;
```

Add `@internal` option overrides to `OnnxEmbeddingSessionOptions`:

```typescript
modelVariant?: string;
executionProviders?: readonly string[];
```

Define one function-type loader, not a factory class:

```typescript
type CandidateSessionLoader = (
  modelName: string,
  candidate: EmbeddingModelCandidate,
  options: OnnxEmbeddingSessionOptions,
) => Promise<OnnxEmbeddingSession>;
```

Export one `@internal` `OnnxSessionCreationError` from this module for the focused
test seam. Wrap only `ort.InferenceSession.create()` failures in that type inside
`createOnnxSessionInternal()`. Model resolution, artifact availability, tokenizer,
and all other loader errors stay untyped and are not eligible for fallback.

- [ ] **Step 4: Resolve candidates once and try them in order**

In `createOnnxSession()`:

1. Load config once.
2. Resolve requested variant/providers from the internal overrides first and config second.
3. Call `resolveEmbeddingModelCandidates()`.
4. Canonicalize omitted and literal `default` as the same automatic request, then
   build the cache key from model, deterministic/throughput mode, canonical request,
   and normalized configured provider order.
5. Try each candidate with the injected loader or `createOnnxSessionInternal`.
6. Retry only when the failed primary error is `OnnxSessionCreationError`; emit one
   bounded warning naming the primary and fallback candidates before the retry.
7. Log the selected model, canonical artifact variant, and actual filtered execution
   providers after a session succeeds.
8. Rethrow untyped failures immediately and the final typed failure if no candidate
   remains.
9. Delete a rejected promise from `sessionCache` exactly as today.

Move artifact selection into `createOnnxSessionInternal(modelName, candidate, options)`: pass `candidate.variantName` to `ensureModelAvailable()` and `resolveModelPath()`, and pass `candidate.requestedProviders` to `resolveEmbeddingSessionOptions()`. Populate the returned identity from the actual session options so diagnostic providers include existing platform filtering and CPU append behavior.

Retain the current request `cacheKey` through the default-loader closure (or as an
internal argument) and use that exact key in the returned session's `dispose()`
method. Do not derive a second eviction key from the selected fallback candidate.

- [ ] **Step 5: Preserve DirectML and deterministic session rules**

Do not change `resolveExecutionProviders()` or `resolveEmbeddingSessionOptions()`. Confirm the existing tests still prove:

```typescript
// DirectML
executionMode: "sequential"
enableMemPattern: false
serializeRuns: true

// Deterministic query
executionProviders: ["cpu"]
intraOpNumThreads: 1
interOpNumThreads: 1
```

- [ ] **Step 6: Rebuild and verify GREEN**

Run the command from Step 2.

Expected: all candidate and provider-policy tests pass. The forced failure returns quantized CPU, never mock.

- [ ] **Step 7: Commit the session boundary**

```powershell
git add src/indexer/embeddings-local.ts tests/unit/embedding-session-candidates.test.ts tests/unit/embeddings-execution-providers.test.ts
git diff --cached --check
git commit -m "feat(embeddings): fall back from Jina FP16 to quantized CPU"
```

### Task 3: Initialize production providers before use

**Files:**

- Modify: `src/indexer/embeddings.ts:85-190,334-410`
- Modify: `src/indexer/file-summary-embeddings.ts:45-115`
- Modify: `src/retrieval/orchestrator.ts:330-385`
- Modify: `src/live-index/overlay-embedding-cache.ts:35-75`
- Modify: `tests/unit/semantic-pipeline-regressions.test.ts`
- Modify: `tests/unit/embeddings-local.test.ts`
- Modify: `tests/unit/retrieval-query-context.test.ts`
- Create: `tests/unit/overlay-embedding-cache.test.ts`

- [ ] **Step 1: Add failing initialization-order checks**

Extend the existing source-contract test to require `await provider.initialize?.()` before `getLadybugConn()` and before either hash/cache pre-pass in both Symbol and FileSummary refreshes. Preserve and assert their existing post-`embed()` mock guards. Extend retrieval and overlay tests with a fake provider whose `initialize()` flips a flag and whose `isMockFallback()` asserts that flag is already true; make the fake degrade during `embed()` and assert that neither path returns or caches the mock vector.

For the overlay test, add one optional constructor function parameter to
`OverlayEmbeddingCache`, defaulting to `getEmbeddingProvider`, and call that function
where the global is called today. Keep the exported singleton unchanged; the test
constructs a private cache with its fake resolver. Do not add a factory or interface.

- [ ] **Step 2: Build and observe RED**

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/semantic-pipeline-regressions.test.ts tests/unit/embeddings-local.test.ts tests/unit/retrieval-query-context.test.ts tests/unit/overlay-embedding-cache.test.ts
```

Expected: FAIL because providers do not expose or call `initialize()`.

- [ ] **Step 3: Add the minimal optional provider lifecycle**

Extend `EmbeddingProvider` without breaking injected mocks:

```typescript
initialize?(): Promise<void>;
getCacheCompatibilityKey?(): string | undefined;
getDiagnosticIdentity?(): {
  modelName: string;
  variantName: string;
  executionProviders: readonly string[];
} | undefined;
```

In `LocalEmbeddingProvider`, remove the constructor's default-variant `isModelAvailable()` shortcut. Implement one idempotent `initialize()` that creates the session, captures its identity, or marks mock fallback after all candidates fail. Make `embed()` await `initialize()` and then either use the initialized session or return mock vectors. API and mock providers need no new methods.

- [ ] **Step 4: Initialize every production local use before fallback checks**

Add `await provider.initialize?.()`:

- at the start of `refreshSymbolEmbeddings()`, before opening LadybugDB;
- at the start of `refreshFileSummaryEmbeddings()`, before opening LadybugDB;
- inside retrieval's async `embeddingFactory()`, before `isMockFallback()`;
- inside `OverlayEmbeddingCache.computeAndCache()`, before `isMockFallback()`.

After `embed()` in retrieval and overlay, recheck `isMockFallback()` before returning or caching a vector so a later inference failure cannot leak a mock vector. Keep the existing Symbol `processBatch()` and FileSummary `embedBatch()` post-embed guards unchanged and covered. Server prewarm already awaits `embed()` and needs no separate branch.

- [ ] **Step 5: Rebuild and verify GREEN**

Run the command from Step 2 plus:

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embeddings-execution-providers.test.ts tests/unit/embedding-session-candidates.test.ts
```

Expected: all pass; production persistence initializes before any DB access.

- [ ] **Step 6: Stage only feature hunks and commit**

`src/indexer/embeddings.ts` and `tests/unit/semantic-pipeline-regressions.test.ts` already contain retained-HNSW work. Use `git add -p` for those two files, then add the clean paths normally. Inspect the complete staged diff before committing:

```powershell
git add src/indexer/file-summary-embeddings.ts src/retrieval/orchestrator.ts src/live-index/overlay-embedding-cache.ts tests/unit/embeddings-local.test.ts tests/unit/retrieval-query-context.test.ts tests/unit/overlay-embedding-cache.test.ts
git add -p src/indexer/embeddings.ts tests/unit/semantic-pipeline-regressions.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
git commit -m "feat(embeddings): initialize effective Jina sessions before use"
```

Do not create a partial Task 3 commit. If either retained-HNSW file cannot be staged
without unrelated hunks, stop and report the boundary. Otherwise rebuild and rerun
the full Task 3 focused command against the staged cohesive source set immediately
before committing.

## Chunk 2: Persistence identity, dual artifacts, and documentation

### Task 4: Invalidate only cross-variant Jina cache rows

**Files:**

- Create: `tests/unit/embedding-cache-identity.test.ts`
- Modify: `src/indexer/embeddings.ts:260-285,500-545`
- Modify: `src/indexer/file-summary-embeddings.ts:75-115`
- Modify: `tests/unit/semantic-pipeline-regressions.test.ts`

- [ ] **Step 1: Write failing pure hash tests**

Specify a shared `hashEmbeddingPayload(parts, cacheCompatibilityKey?)` helper:

```typescript
const parts = ["symbol-1", "payload"];
assert.equal(hashEmbeddingPayload(parts), hashContent(parts.join("|")));
assert.notEqual(
  hashEmbeddingPayload(parts, "jina-embeddings-v2-base-code:model_fp16.onnx"),
  hashEmbeddingPayload(parts, "jina-embeddings-v2-base-code:model_quantized.onnx"),
);
```

Also resolve Jina `default`, `int8`, and `fp16` candidates and prove the two quantized aliases hash identically while FP16 differs. Prove an undefined key retains the old digest, which keeps Nomic cache rows valid.

Before implementation, extend the existing source-contract test to prove both
persistence paths initialize first, then read the effective compatibility key, then
hash. Assert that a simulated settled quantized key reaches the Symbol and
FileSummary hash calls and that neither path embeds a pre-initialization FP16 literal.
Use this source contract plus the pure helper seam; do not open LadybugDB or add a
provider injection abstraction.

- [ ] **Step 2: Build and observe RED**

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embedding-cache-identity.test.ts tests/unit/semantic-pipeline-regressions.test.ts
```

Expected: FAIL because the helper and persistence wiring do not exist.

- [ ] **Step 3: Implement the shared hash helper**

In `embeddings.ts`, export this internal helper and route `buildCardHash()` through it:

```typescript
export function hashEmbeddingPayload(
  parts: readonly string[],
  cacheCompatibilityKey?: string,
): string {
  return hashContent(
    (cacheCompatibilityKey ? [...parts, cacheCompatibilityKey] : parts).join("|"),
  );
}
```

After provider initialization, read `provider.getCacheCompatibilityKey?.()` only when the storage model is Jina. Pass that key into every Symbol `buildCardHash()` call. In `file-summary-embeddings.ts`, replace its inline `hashContent()` call with `hashEmbeddingPayload([summary.fileId, prefixedText], jinaKey)`.

- [ ] **Step 4: Wire the settled identity into both persistence hashes**

After provider initialization, capture the effective key once and pass it through the
Symbol and FileSummary hash calls specified in Step 1. The Chunk 1 session test owns
the forced FP16-to-quantized fallback; this task only consumes its settled identity.

- [ ] **Step 5: Rebuild and verify GREEN**

Run the focused cache test plus the Chunk 1 tests.

Expected: all pass; no schema or row-ID changes appear in the diff.

- [ ] **Step 6: Commit only cache-identity hunks**

Use hunk staging for the two already modified product files, add the new test normally, inspect, then commit:

```powershell
git add tests/unit/embedding-cache-identity.test.ts
git add -p src/indexer/embeddings.ts src/indexer/file-summary-embeddings.ts tests/unit/semantic-pipeline-regressions.test.ts
git diff --cached --check
git diff --cached --name-status
git diff --cached
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embedding-cache-identity.test.ts tests/unit/semantic-pipeline-regressions.test.ts
git commit -m "fix(embeddings): key Jina caches by effective artifact"
```

Stop without committing if any required cache-identity hunk cannot be isolated from
the retained-HNSW work or if the staged focused gate fails.

### Task 5: Install and verify both pinned Jina graphs

**Files:**

- Modify: `tests/unit/postinstall-models.test.ts`
- Modify: `scripts/postinstall-models.mjs:25-100`

- [ ] **Step 1: Tighten the provenance test first**

Change the provenance assertions from “three files for every model” to model-specific expectations:

```typescript
const jina = provenance.find(({ name }) =>
  name === "jina-embeddings-v2-base-code"
);
assert.deepStrictEqual(
  jina?.files.map(({ name }) => name),
  ["model_fp16.onnx", "model_quantized.onnx", "tokenizer.json", "config.json"],
);
assert.equal(
  jina?.files.find(({ name }) => name === "model_fp16.onnx")?.sha256,
  "1aafc4fcd63d2e6899e88402ff731e7c646c2e435048294a3cbc908a40d45d7c",
);
assert.equal(
  jina?.files.find(({ name }) => name === "model_quantized.onnx")?.sha256,
  "ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d",
);
```

Assert both Jina graph URLs exactly equal their pinned Hugging Face revision paths.
Allow an absent fallback only for FP16; keep numeric GitHub asset fallbacks mandatory
for every existing mirrored file. Nomic remains three files.

Extend the existing isolated verifier fixture before implementation:

- overwrite verified ONNX bytes without changing the expected digest and assert a
  SHA-256 mismatch;
- create a correctly hashed artifact larger than the fixture's `maxBytes` and assert
  the size-limit error;
- restore valid bytes between cases so JSON and provenance assertions remain isolated.

These fixture checks run in CI and must not depend on the developer's live model cache.

- [ ] **Step 2: Observe RED**

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/postinstall-models.test.ts
```

Expected: FAIL because FP16 is absent from Jina provenance.

- [ ] **Step 3: Add FP16 to the existing manifest**

Add `model_fp16.onnx` before `model_quantized.onnx` in Jina's `files`, `sha256`, and `primary` entries. Use:

```javascript
"model_fp16.onnx":
  `https://huggingface.co/jinaai/jina-embeddings-v2-base-code/resolve/${JINA_REVISION}/onnx/model_fp16.onnx`
```

Do not invent a GitHub fallback asset. Raise Jina's existing per-model download cap from `200_000_000` to `400_000_000` bytes so the verified 321,072,580-byte FP16 graph fits. Hash verification remains the strict integrity control.

- [ ] **Step 4: Verify strict missing/corrupt behavior remains intact**

Run the postinstall test. Then run:

```powershell
node scripts/postinstall-models.mjs --strict
```

Expected locally: exit `0`; both Jina ONNX files, tokenizer, config, and all Nomic files verify. This command is model-cache-only and must not open LadybugDB.

- [ ] **Step 5: Commit the installer contract**

```powershell
git add scripts/postinstall-models.mjs tests/unit/postinstall-models.test.ts
git diff --cached --check
git commit -m "feat(models): install Jina FP16 and quantized graphs"
```

### Task 6: Synchronize configuration and public documentation

**Files:**

- Modify: `src/config/types.ts:655-710`
- Modify: `config/sdlmcp.config.schema.json:980-1010`
- Verify: `config/sdlmcp.config.example.json:157-181`
- Modify: `src/indexer/AGENTS.md:54-58`
- Modify: `docs/configuration-reference.md:368-415`
- Modify: `docs/architecture.md:30-40,210-225`
- Modify: `docs/feature-deep-dives/semantic-embeddings-setup.md:60-100,396-410,532-590,707-760,809-820`
- Modify: `docs/feature-deep-dives/semantic-engine.md:403-445,541-575`
- Modify: `CHANGELOG.md` under `Unreleased > Changed`
- Test: `tests/unit/embeddings-config-knobs.test.ts`
- Modify: `tests/unit/config-surface-sync.test.ts`

- [ ] **Step 1: Add the config-description regression**

Keep the schema type unchanged, but assert the generated schema description says that Jina `default` is provider-aware, DirectML indexing selects FP16, and deterministic/CPU sessions select quantized. Keep the default provider array `["cpu"]`.

Keep the example's literal `"modelVariant": "default"`; this is the documented
automatic mode, not an explicit quantized pin. In `config-surface-sync.test.ts`, parse
the example and assert that literal `default` produces the automatic Jina candidates:
quantized for its CPU providers and FP16 then quantized for an otherwise identical
`["dml", "cpu"]` provider order.

- [ ] **Step 2: Build and observe RED**

```powershell
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embeddings-config-knobs.test.ts tests/unit/config-surface-sync.test.ts
```

Expected: FAIL because the generated schema and source description still describe
the old fixed quantized default.

- [ ] **Step 3: Update source comments and schema text**

Replace statements that call quantized Jina the fixed shipped default. Document these exact rules:

- omitted/`default` Jina + DirectML-first throughput session → FP16;
- only configured adjacent `dml,cpu` enables a second quantized CPU variant candidate;
- deterministic and CPU sessions → quantized;
- explicit non-default variants stay authoritative;
- the provider helper still filters unsupported providers and appends CPU at the ONNX session layer.

Do not change the Zod field, schema default, or public provider list.

- [ ] **Step 4: Update install, cache, and migration guidance**

State that npm postinstall caches and SHA-256 verifies both Jina graphs (~321 MB
FP16 and ~162 MB quantized), Nomic remains unchanged, and a Jina effective-artifact
change invalidates Jina Symbol and FileSummary card hashes on the next explicitly
initiated semantic index. Remove the unsupported blanket “combine FP16 with GPU for
3–8×” claim; the acceptance probe reports local timing without making it a product
guarantee.

- [ ] **Step 5: Preserve current retained-HNSW documentation hunks**

Before editing each dirty doc, inspect its current diff. Change only provider/model paragraphs. Do not rewrite or stage retained-HNSW wording in `architecture.md`, `semantic-embeddings-setup.md`, `semantic-engine.md`, `src/indexer/AGENTS.md`, or `CHANGELOG.md`.

- [ ] **Step 6: Run documentation and schema checks**

```powershell
npm run build:all
npm run typecheck
npm run lint
npm run check:config-sync
npm run check:schema-sync
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embeddings-config-knobs.test.ts tests/unit/config-surface-sync.test.ts
```

Expected: every command exits `0`.

- [ ] **Step 7: Stage only this feature's documentation hunks**

Use normal staging for clean config paths and interactive hunk staging for dirty docs:

```powershell
git add src/config/types.ts config/sdlmcp.config.schema.json config/sdlmcp.config.example.json tests/unit/embeddings-config-knobs.test.ts tests/unit/config-surface-sync.test.ts
git add -p src/indexer/AGENTS.md docs/configuration-reference.md docs/architecture.md docs/feature-deep-dives/semantic-embeddings-setup.md docs/feature-deep-dives/semantic-engine.md CHANGELOG.md
git diff --cached --check
git diff --cached --name-status
git diff --cached
npm run build:all
node --experimental-strip-types --test-concurrency=1 --test tests/unit/embeddings-config-knobs.test.ts tests/unit/config-surface-sync.test.ts
git commit -m "docs(embeddings): explain GPU-aware Jina defaults"
```

Do not create an incomplete documentation commit. If any required provider/model hunk
mixes with retained-HNSW text and cannot be isolated, stop and report the boundary
instead of committing a partial or contaminated staged set.

## Chunk 3: Database-free acceptance and safe global activation

### Task 7: Build a reproducible isolated Jina acceptance probe

**Files:**

- Create: `scripts/jina-gpu-aware-probe-contract.mjs`
- Create: `scripts/probe-jina-gpu-aware-default.mjs`
- Create: `tests/unit/jina-gpu-aware-probe-contract.test.ts`

- [ ] **Step 1: Write failing pure contract tests**

Define synthetic 768-dimensional normalized vectors and test `evaluateJinaProbe({ dml, cpu, fallback })` for:

- reported identities exactly FP16/DirectML and quantized/CPU;
- finite normalized 768-dimensional vectors;
- exact repeated CPU vectors;
- minimum paired cosine `0.99`;
- quantized query vectors ranking the FP16 corpus with each expected fixture target at top-1;
- control quantized query/corpus targets also at top-1.

Use an explicit normalization tolerance of `1e-5`; add boundary cases that accept a
norm difference of exactly `1e-5` and reject the next representable test value above
it. Add one failure case for every quality gate.

Before implementation, cover every child boundary: signal, nonzero exit, stdout over
`512 KiB`, empty output, partial JSON, malformed JSON, missing fields, and non-finite
first-pass or repeat timing. Add fallback-result cases proving automatic mode reports
real quantized/CPU identity while explicit FP16 reports one failed attempt.

- [ ] **Step 2: Observe RED**

```powershell
node --experimental-strip-types --test-concurrency=1 --test tests/unit/jina-gpu-aware-probe-contract.test.ts
```

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement the dependency-free contract**

`scripts/jina-gpu-aware-probe-contract.mjs` owns only:

- bounded child spawning and strict JSON parsing;
- vector shape/finite/norm validation with `1e-5` L2 tolerance;
- cosine similarity and deterministic score ordering;
- paired FP16/quantized cosine checks;
- cross-variant and all-quantized expected-target ranking;
- one compact result object with identities, quality results, comparable first-pass
  milliseconds, and a separate CPU determinism-repeat duration.

Use a `512 KiB` stdout cap per child because each returns a small fixed set of
768-dimensional vectors. Reject partial output, signals, nonzero exits, malformed
JSON, and non-finite timing.

- [ ] **Step 4: Implement the real child/parent probe**

`scripts/probe-jina-gpu-aware-default.mjs` reads the two existing fixtures:

```text
tests/fixtures/semantic-test-cases/test_sample.py
tests/fixtures/semantic-test-cases/sample.test.ts
```

Use those file contents as the two corpus documents. Use queries `helper_target python function` → Python and `nestedHelper typescript function` → TypeScript, with required top-1.

Parent mode spawns separate `dml` and `cpu` children so a fatal DirectML exit cannot mutate config or kill the parent. Child mode imports `createOnnxSession()` from `--module-root <package>/dist/indexer/embeddings-local.js` and uses internal overrides:

```javascript
// DML child
{
  deterministic: false,
  modelVariant: "default",
  executionProviders: ["dml", "cpu"],
}

// CPU child
{
  deterministic: true,
  modelVariant: "default",
  executionProviders: ["cpu"],
}
```

Create each session before starting a timer. DML and CPU then each time one identical
ordered first-pass batch containing corpus plus queries. The CPU child embeds that
same batch a second time, outside the first-pass measurement, and reports the repeat
vectors plus `determinismRepeatMs`. Report and compare only the two first-pass times;
the CPU repeat is a separate determinism cost, not part of the CPU/DML speed comparison.

Spawn a third isolated `fallback` child. Its injected loader throws
`OnnxSessionCreationError` for FP16, then delegates the quantized candidate to a real
global `createOnnxSession()` call using explicit `int8` and CPU. Assert automatic
`default` with `["dml", "cpu"]` returns non-mock quantized/CPU vectors. In the same
isolated child, call explicit `fp16` with the forced loader and assert one attempt plus
rejection, with no quantized retry.

Parent mode evaluates all three child records and prints one JSON record; it exits
nonzero on any failed gate.

- [ ] **Step 5: Verify the pure contract GREEN**

Run the test from Step 2.

Expected: exit `0`; no ONNX model or database is loaded by the unit test.

- [ ] **Step 6: Commit the acceptance harness**

```powershell
git add scripts/jina-gpu-aware-probe-contract.mjs scripts/probe-jina-gpu-aware-default.mjs tests/unit/jina-gpu-aware-probe-contract.test.ts
git diff --cached --check
git commit -m "test(embeddings): add isolated Jina GPU-aware acceptance"
```

### Task 8: Run source verification and activate the global package

**Files:**

- Verify only; no source edits expected.
- Install target: global `sdl-mcp` package returned by `npm root -g`.
- Model cache: existing platform cache returned by `scripts/postinstall-models.mjs`.

- [ ] **Step 1: Run the focused test set from a fresh temp root**

Use a unique resolved temp directory and restore the caller's environment even when a
gate fails:

```powershell
$jinaOriginalTemp = $env:TEMP
$jinaOriginalTmp = $env:TMP
$jinaTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$jinaTestTemp = [System.IO.Path]::GetFullPath((Join-Path $jinaTempRoot ("sdl-jina-gpu-aware-tests-" + [guid]::NewGuid().ToString("N"))))
if (-not $jinaTestTemp.StartsWith($jinaTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe test temp path" }
New-Item -ItemType Directory -Path $jinaTestTemp | Out-Null
try {
  $env:TEMP = $jinaTestTemp
  $env:TMP = $jinaTestTemp
  npm run build:all
  if ($LASTEXITCODE -ne 0) { throw "build failed" }
  node --experimental-strip-types --test-concurrency=1 --test tests/unit/model-registry.test.ts tests/unit/embedding-session-candidates.test.ts tests/unit/embeddings-execution-providers.test.ts tests/unit/embeddings-local.test.ts tests/unit/embedding-cache-identity.test.ts tests/unit/postinstall-models.test.ts tests/unit/jina-gpu-aware-probe-contract.test.ts tests/unit/semantic-pipeline-regressions.test.ts tests/unit/embeddings-config-knobs.test.ts tests/unit/config-surface-sync.test.ts tests/unit/retrieval-query-context.test.ts tests/unit/overlay-embedding-cache.test.ts
  if ($LASTEXITCODE -ne 0) { throw "focused tests failed" }
} finally {
  $env:TEMP = $jinaOriginalTemp
  $env:TMP = $jinaOriginalTmp
}
```

Expected: build and all focused tests exit `0`.

- [ ] **Step 2: Run proportional project gates**

```powershell
npm run typecheck
npm run lint
npm run check:config-sync
npm run check:schema-sync
```

Use `@test-scope` to confirm whether any additional semantic integration file is required. If it selects `tests/integration/semantic-embedding.test.ts`, run that file alone against the same fresh TEMP/TMP root. Do not run a real index.

Because Step 1 restores the caller environment, temporarily reassign `TEMP` and `TMP`
to the existing unique `$jinaTestTemp` inside another `try/finally` only around any
selected integration test, then restore them again.

- [ ] **Step 3: Confirm the server and graph are untouched before installation**

Use this concrete Windows process query before installation and again after activation:

```powershell
function Get-SdlHttpProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    if ($_.ProcessId -eq $PID) { return $false }
    if ($_.Name -notmatch '^(?i:node(?:\.exe)?|sdl-mcp(?:\.exe)?)$') { return $false }
    $line = [string]$_.CommandLine
    $entrypoint =
      $line -match '(?i)(?:^|[\s"])(?:sdl-mcp(?:\.cmd|\.ps1|\.exe)?)(?=[\s"]|$)' -or
      $line -match '(?i)(?:^|[\s"])(?:"?[^"\r\n]*[\\/])?dist[\\/]cli[\\/]index\.js(?=["\s]|$)'
    $serverMode =
      $line -match '(?i)\bserve\b' -or
      $line -match '(?i)(--http\b|--transport(?:=|\s+)http\b)'
    $entrypoint -and $serverMode
  } | Select-Object ProcessId, Name, CommandLine)
}
```

Resolve the graph path from the active config without opening LadybugDB. Snapshot the
exact graph entry plus every same-directory entry whose name starts with the graph
leaf and contains `wal` or `lock`. Sort by full path and record `FullName`, existence,
file/directory kind, length (for files), and `LastWriteTimeUtc`; serialize that snapshot
for a byte-stable comparison after activation. An absent WAL/lock set is part of the
baseline, so a newly created sidecar fails the final check.

Record:

- no running process whose command line starts SDL-MCP `serve` or HTTP transport;
- active config path `F:\Claude\sdl-mcp\sdlmcp.config.json`;
- its graph path value;
- graph plus WAL/lock existence, kind, length, and last-write timestamp;
- active semantic providers and modelVariant.

Stop if `Get-SdlHttpProcesses` returns any row. Do not stop it automatically unless
the user has authorized that process action in the execution turn.

- [ ] **Step 4: Install the built checkout globally as a copy**

After source gates pass, request the required sandbox/network approval and run:

```powershell
npm install -g . --install-links=false
```

Expected: exit `0`; `npm root -g` contains `sdl-mcp`, and its `package.json` reports version `0.13.5`. Compare SHA-256 for the local/global built `dist/indexer/model-registry.js`, `dist/indexer/embeddings-local.js`, and `dist/indexer/embeddings.js`; all three pairs must match.

- [ ] **Step 5: Strictly verify both globally required Jina artifacts**

Run the global copy's installer in strict mode:

```powershell
$jinaGlobalRoot = Join-Path (npm root -g) 'sdl-mcp'
node (Join-Path $jinaGlobalRoot 'scripts/postinstall-models.mjs') --strict
```

Expected: exit `0`. Verify:

```text
model_fp16.onnx       1aafc4fcd63d2e6899e88402ff731e7c646c2e435048294a3cbc908a40d45d7c
model_quantized.onnx  ed45870251c9f0cf656e78aab0d37a23489066df8a222bb1c8caf8a45f2cb16d
```

If download or verification fails, stop. Keep the active CPU config unchanged.

### Task 9: Probe first, then atomically activate the current config

**Files:**

- Run: `scripts/probe-jina-gpu-aware-default.mjs`
- Operationally update: `F:\Claude\sdl-mcp\sdlmcp.config.json`
- Preserve: configured LadybugDB path and all graph files.

- [ ] **Step 1: Run global DML and CPU acceptance before config mutation**

```powershell
$jinaGlobalRoot = Join-Path (npm root -g) 'sdl-mcp'
node scripts/probe-jina-gpu-aware-default.mjs --module-root $jinaGlobalRoot
```

Expected: exit `0` with one compact result proving:

- DML child identity is Jina FP16 with DirectML leading;
- deterministic child identity is quantized Jina on CPU;
- all vectors are finite, normalized, and 768-dimensional;
- repeated CPU vectors are byte-stable;
- every paired vector cosine is at least `0.99`;
- both cross-variant and quantized controls return expected fixture targets at top-1;
- the forced automatic fallback child returns real quantized/CPU vectors, while its
  explicit FP16 control attempts once and rejects;
- CPU and DML inference-only first-pass milliseconds are compared on the identical
  batch without a speed pass/fail claim; CPU repeat milliseconds are reported
  separately.

If the DML child terminates or any gate fails, stop. The original CPU config remains active.

- [ ] **Step 2: Prepare and validate the config change without touching the active file**

Resolve exact paths, refuse to reuse the rollback name, and create a unique
same-directory temp path:

```powershell
$configPath = [System.IO.Path]::GetFullPath('F:\Claude\sdl-mcp\sdlmcp.config.json')
$configDir = [System.IO.Path]::GetDirectoryName($configPath)
$backupPath = Join-Path $configDir 'sdlmcp.config.pre-gpu-aware.bak'
if ([System.IO.File]::Exists($backupPath)) { throw "Refusing to overwrite existing backup: $backupPath" }
$tempPath = [System.IO.Path]::GetFullPath((Join-Path $configDir ('.sdlmcp.config.gpu-aware.' + [guid]::NewGuid().ToString('N') + '.tmp')))
if ([System.IO.Path]::GetDirectoryName($tempPath) -ne $configDir) { throw "Config temp escaped its directory" }
$originalBytes = [System.IO.File]::ReadAllBytes($configPath)
```

Use a small Node inline script with `readFileSync`, `JSON.parse`, and
`writeFileSync(..., { flag: "wx" })` to preserve object property order and all
unrelated JSON values. Change only:

```json
"executionProviders": ["dml", "cpu"]
```

Remove the `semantic.modelVariant` property so automatic mode is unambiguous. Validate the temporary path with the newly built `loadConfig(tempPath)` and assert:

```text
graphDbPath = F:/Claude/sdl-mcp/sdlmcp-graph.lbug
executionProviders = dml,cpu
modelVariant = undefined
```

Do not open LadybugDB during validation.

Define one PowerShell `Invoke-JinaConfigValidation` helper that launches the global
Node runtime in a fresh process, imports
`<global-root>/dist/config/loadConfig.js` and
`<global-root>/dist/db/graph-db-path.js`, calls `loadConfig(candidatePath)` and
`resolveGraphDbPath(config, candidatePath)`, and returns only compact JSON containing
normalized `graphDbPath`, `executionProviders`, and `modelVariant` (`null` when
omitted). Run it once on the original file and save that result for rollback proof;
then run it on the temp file and enforce the three assertions above before replacing
anything.

- [ ] **Step 3: Atomically replace and read back the active config**

Use the exact same-volume replace flow:

```powershell
try {
  if ((Get-SdlHttpProcesses).Count -ne 0) {
    throw "SDL-MCP server appeared after the pre-install baseline; refusing config activation"
  }
  [System.IO.File]::Replace($tempPath, $configPath, $backupPath, $true)
  $backupBytes = [System.IO.File]::ReadAllBytes($backupPath)
  if (-not [System.Linq.Enumerable]::SequenceEqual[byte]($originalBytes, $backupBytes)) {
    throw "Rollback backup is not byte-identical to the original config"
  }

  $activeValidation = Invoke-JinaConfigValidation $configPath
  # Assert graphDbPath, dml,cpu, and omitted modelVariant exactly as in Step 2.
} catch {
  if ([System.IO.File]::Exists($backupPath)) {
    $rollbackTemp = Join-Path $configDir ('.sdlmcp.config.rollback.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $failedPath = Join-Path $configDir ('.sdlmcp.config.failed.' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllBytes($rollbackTemp, $originalBytes)
    [System.IO.File]::Replace($rollbackTemp, $configPath, $failedPath, $true)
    $restoredBytes = [System.IO.File]::ReadAllBytes($configPath)
    if (-not [System.Linq.Enumerable]::SequenceEqual[byte]($originalBytes, $restoredBytes)) {
      throw "Atomic rollback did not restore the original bytes"
    }
    $restoredValidation = Invoke-JinaConfigValidation $configPath
    # Assert the restored result equals the saved original validation result.
  }
  throw
}
```

This preserves the original backup even during rollback: rollback replaces from a
copy and stores the rejected active file separately. Do not delete or overwrite the
backup in this task. Any cleanup may remove only validated same-directory unique temp
files, never the backup or failed-file evidence.

- [ ] **Step 4: Verify no graph or server side effect**

Serialize the graph/WAL/lock footprint exactly as in Task 8 Step 3 and require it to
equal the pre-install baseline. Run `Get-SdlHttpProcesses` again and require zero rows.

Expected: graph metadata is unchanged, the server is stopped, and only package/model-cache/config state changed.

- [ ] **Step 5: Inspect final repository scope**

```powershell
git status --short
git diff --check
git log -8 --oneline
```

Expected: planned feature commits are local; pre-existing retained-HNSW edits remain preserved if they were not independently committed. No graph database, config backup, model binary, or global package path appears in the repository diff.

- [ ] **Step 6: Report activation evidence**

Report:

- focused gates and any additional `@test-scope` test;
- global local/dist hash parity;
- both model artifact hashes;
- DML and CPU identities, quality gates, and measured milliseconds;
- active config provider order, omitted variant, and preserved graph path;
- unchanged graph metadata and stopped server;
- any intentionally unstaged overlapping documentation/source hunks.

Do not claim a full-index performance result. A full CPU/DML index remains separately gated by explicit index-refresh authorization.
