# Tier 3 Semantic Embedding Pipeline — Implementation Plan

## Context

SDL-MCP has a complete embedding infrastructure (providers, HNSW ANN index, Float16 storage, cosine reranking, summary generation) that is entirely stubbed out. All three embedding providers produce identical 64-dim SHA-256 hash vectors. The ONNX runtime is imported only as an availability probe — no model is ever loaded. The `rerankByEmbeddings()` function exists but is never called from search. This plan activates the entire pipeline with real ONNX model inference.

**Goal**: Real semantic search using local ONNX models with three quality tiers:

| Tier | Model | Embeds | Quality | Cost |
|---|---|---|---|---|
| **Low (default)** | all-MiniLM-L6-v2 (384-dim) | Raw symbol text | Basic — general text model, treats code as English | Free, bundled (~22MB) |
| **Medium (opt-in)** | nomic-embed-code-v1 (768-dim) | Raw symbol text | Better — trained on code, understands code semantics natively without needing LLM summaries | Free, download-on-demand (~274MB) |
| **High (opt-in)** | all-MiniLM-L6-v2 (384-dim) | LLM-generated summaries | Best — Anthropic distills code meaning into natural language, MiniLM embeds that rich text | API tokens |

The tiers form a quality ladder: MiniLM is a general text encoder that doesn't understand code patterns well, so it benefits most from LLM-generated summaries that translate code into English. nomic-embed-code was trained on code and naturally produces high-quality code embeddings from raw symbol text — no LLM summaries needed. This makes nomic the sweet spot for users who want better-than-baseline quality without spending API tokens.

---

## Phase 1 — Model Management & Registry

### 1a. Bundle MiniLM-L6-v2 model files

Create `models/all-MiniLM-L6-v2/` with three files from HuggingFace:
- `model_quantized.onnx` (~22MB INT8)
- `tokenizer.json` (~466KB)
- `config.json` (~600B, contains `hidden_size: 384`)

**Files to change:**
- `package.json` — add `"models"` to the `files` array
- `.gitattributes` — add `models/**/*.onnx filter=lfs` (Git LFS for the binary)

Create `scripts/download-models.mjs` — dev script that fetches from HuggingFace:
- `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx`
- `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json`
- `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/config.json`

### 1b. Create model registry

**New file: `src/indexer/model-registry.ts`**

```typescript
export interface ModelInfo {
  name: string;
  dimension: number;
  maxSequenceLength: number;
  bundled: boolean;
  modelFile: string;       // e.g. "model_quantized.onnx"
  tokenizerFile: string;   // e.g. "tokenizer.json"
  description: string;
}

export function getModelInfo(name: string): ModelInfo;
export function resolveModelPath(name: string): string;  // bundled → models/, nomic → cache dir
export function getModelCacheDir(): string;               // platform-specific cache
```

Registry entries:
| Model | Dimension | MaxSeqLen | Bundled | File |
|---|---|---|---|---|
| `all-MiniLM-L6-v2` | 384 | 256 | yes | `model_quantized.onnx` |
| `nomic-embed-code-v1` | 768 | 8192 | no | `model.onnx` |

Cache dir for nomic: `%LOCALAPPDATA%/sdl-mcp/models/` (Win), `~/.cache/sdl-mcp/models/` (Linux/Mac). Override via `semantic.modelCacheDir` config.

### 1c. Create model downloader (nomic only)

**New file: `src/indexer/model-downloader.ts`**

- `ensureModelAvailable(name: string): Promise<string>` — returns model dir path
- For bundled models: verify files exist, return path
- For nomic: check cache dir → download from HuggingFace if missing → verify SHA-256 → return path
- Progress logging via `src/util/logger.ts`
- Clear error message if download fails (offline, etc.)

---

## Phase 2 — ONNX Inference Engine

### 2a. Add `tokenizers` dependency

**File: `package.json`**

Add to `optionalDependencies`:
```json
"tokenizers": "^0.22.0"
```

This is the HuggingFace Rust-compiled napi-rs tokenizer (~5MB). Handles WordPiece (MiniLM) and BPE (nomic) via the same `tokenizer.json` format.

### 2b. Rewrite `src/indexer/embeddings-local.ts`

Current: 26-line stub that only checks if onnxruntime-node can be imported.

New structure:

```typescript
export interface OnnxEmbeddingSession {
  embed(texts: string[]): Promise<number[][]>;
  dimension: number;
  modelName: string;
  dispose(): void;
}

export async function createOnnxSession(modelName: string): Promise<OnnxEmbeddingSession>;
```

Implementation of `createOnnxSession()`:
1. Resolve model path via `model-registry.ts` (bundled or cache)
2. If not bundled, call `ensureModelAvailable()` from `model-downloader.ts`
3. Dynamic import `onnxruntime-node` → create `InferenceSession.create(modelPath)`
4. Dynamic import `tokenizers` → load `Tokenizer.fromFile(tokenizerJsonPath)`
5. Read `config.json` → extract `hidden_size` as dimension
6. Return session object with `embed()` method

Implementation of `embed(texts)`:
1. Tokenize batch: `tokenizer.encodeBatch(texts)` → get `ids`, `attentionMask`, `typeIds`
2. Pad to max length in batch, truncate to model's `maxSequenceLength`
3. Create `ort.Tensor` instances: `input_ids` (int64), `attention_mask` (int64), `token_type_ids` (int64)
4. Run `session.run({ input_ids, attention_mask, token_type_ids })` → `last_hidden_state` [batch, seq_len, dim]
5. Mean pool: for each sequence, average token embeddings weighted by attention_mask
6. L2-normalize each vector (reuse existing `normalizeVector()`)
7. Return `number[][]`

Batch size: process up to 32 texts per inference call.

Session caching: singleton `Map<string, OnnxEmbeddingSession>` keyed by model name — load once, reuse across all embedding calls.

Keep the existing `ensureLocalEmbeddingRuntime()` export for backward compat but have it also verify the tokenizer package is available.

---

## Phase 3 — Provider & Config Changes

### 3a. Update `EmbeddingProvider` interface

**File: `src/indexer/embeddings.ts`**

Add `getDimension()` to the interface:
```typescript
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}
```

Provider implementations:
- `MockEmbeddingProvider.getDimension()` → `64`
- `LocalEmbeddingProvider.getDimension()` → reads from model registry (384 or 768)
- `ApiEmbeddingProvider.getDimension()` → `64` (stub, unchanged)

### 3b. Rewrite `LocalEmbeddingProvider`

**File: `src/indexer/embeddings.ts`**

Replace the current stub with:
```typescript
class LocalEmbeddingProvider implements EmbeddingProvider {
  private session: OnnxEmbeddingSession | null = null;
  private modelName: string;

  constructor(modelName: string) { this.modelName = modelName; }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.session) {
      this.session = await createOnnxSession(this.modelName);
    }
    return this.session.embed(texts);
  }

  getDimension(): number {
    return this.session?.dimension ?? getModelInfo(this.modelName).dimension;
  }
}
```

### 3c. Update provider factory

**File: `src/indexer/embeddings.ts`**

Change `getEmbeddingProvider()` signature:
```typescript
export function getEmbeddingProvider(
  provider: "api" | "local" | "mock",
  model?: string,
): EmbeddingProvider
```

Pass model through in `"local"` case. Update callers: `refreshSymbolEmbeddings()` and `rerankByEmbeddings()` (both in same file).

### 3d. Remove hardcoded `EMBEDDING_DIMENSION`

**Files: `src/indexer/embeddings.ts`, `src/indexer/ann-index.ts`**

- Remove `export const EMBEDDING_DIMENSION = 64` from both files
- `ann-index.ts`: read dimension from the first vector inserted, or from config
- `embeddings.ts`: use `provider.getDimension()` where dimension is needed
- Keep `EMBEDDING_DIMENSION = 64` only in `MockEmbeddingProvider` scope

### 3e. Update config defaults

**File: `src/config/types.ts`**

```diff
 AnnConfigSchema = z.object({
-  enabled: z.boolean().default(false),
+  enabled: z.boolean().default(true),
   ...
 })

 SemanticConfigSchema = z.object({
   ...
-  provider: z.enum(["api", "local", "mock"]).default("mock"),
+  provider: z.enum(["api", "local", "mock"]).default("local"),
-  model: z.string().default("all-MiniLM-L6-v2"),
+  model: z.enum(["all-MiniLM-L6-v2", "nomic-embed-code-v1"]).default("all-MiniLM-L6-v2"),
+  modelCacheDir: z.string().nullish(),
   ...
 })
```

### 3f. Mirror in JSON schema + example config

**File: `config/sdlmcp.config.schema.json`**
- `ann.enabled` default → `true`
- `provider` default → `"local"`
- `model` add enum + `"nomic-embed-code-v1"`
- Add `modelCacheDir` property

**File: `config/sdlmcp.config.example.json`**
- Update defaults to match

---

## Phase 4 — Pipeline Reordering

### 4a. Swap summary/embedding order

**File: `src/indexer/metrics-updater.ts` — `finalizeIndexing()`**

Current order: embeddings → summaries
New order:

```
if (semantic.enabled) {
  const model = semantic.model ?? "all-MiniLM-L6-v2";
  const isCodeModel = model === "nomic-embed-code-v1";

  // 1. Summaries first (if opt-in AND using MiniLM) — so MiniLM can embed them
  //    nomic-embed-code doesn't need summaries — it understands code natively
  if (semantic.generateSummaries && !isCodeModel) {
    summaryStats = await generateSummariesForRepo(repoId, appConfig);
  }

  // 2. Embeddings second — uses summaries when available (MiniLM high-tier),
  //    or raw symbol text (MiniLM low-tier and nomic medium-tier)
  await refreshSymbolEmbeddings({
    repoId,
    provider: semantic.provider ?? "local",
    model,
  });

  // 3. ANN index rebuild
  if (semantic.ann?.enabled !== false) {  // enabled by default now
    const annManager = getAnnIndexManager(semantic.ann);
    await annManager.buildIndex({ repoId, model });
  }
}
```

### 4b. Smart embedding text construction

**File: `src/indexer/embeddings.ts` — `refreshSymbolEmbeddings()`**

Replace the current text construction with tier-aware logic:

```typescript
// Old: const text = `${symbol.name}\n${symbol.kind}\n${symbol.summary ?? ""}`;

// New: text depends on which quality tier is active
const isCodeModel = modelName === "nomic-embed-code-v1";

let text: string;
if (isCodeModel) {
  // Medium tier (nomic): embed raw code text — the model understands code natively
  text = buildCodeEmbeddingText(symbol);
} else {
  // Low tier (MiniLM on raw text) OR High tier (MiniLM on LLM summaries)
  const cachedSummary = await getSummaryCache(conn, symbol.symbolId);
  const hasLLMSummary = cachedSummary && cachedSummary.provider !== "mock";
  text = hasLLMSummary
    ? `${symbol.name} (${symbol.kind}): ${cachedSummary.summary}`
    : buildRawEmbeddingText(symbol);
}
```

Two text-building helpers:

```typescript
/** For MiniLM (general text model): name + kind + signature + summary */
function buildRawEmbeddingText(symbol: SymbolRow): string {
  const parts = [`${symbol.name} (${symbol.kind})`];
  if (symbol.signatureJson) {
    try { parts.push(JSON.parse(symbol.signatureJson)); } catch { parts.push(symbol.signatureJson); }
  }
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join("\n");
}

/** For nomic-embed-code (code-trained model): include more code context
 *  since the model can directly understand code patterns, signatures,
 *  and structural relationships without needing English translation */
function buildCodeEmbeddingText(symbol: SymbolRow): string {
  const parts = [`${symbol.kind} ${symbol.name}`];
  if (symbol.signatureJson) {
    try { parts.push(JSON.parse(symbol.signatureJson)); } catch { parts.push(symbol.signatureJson); }
  }
  if (symbol.filePath) parts.push(`// ${symbol.filePath}`);
  if (symbol.summary) parts.push(`// ${symbol.summary}`);
  return parts.join("\n");
}
```

The key difference: `buildCodeEmbeddingText` formats text as pseudo-code (comments for metadata) because nomic was trained on code and responds better to code-like formatting. `buildRawEmbeddingText` formats as natural language because MiniLM is a text model.

---

## Phase 5 — Search Integration

### 5a. Wire reranking into search

**File: `src/mcp/tools/symbol.ts` — `handleSymbolSearch()`**

After lexical results, add semantic reranking:

```typescript
const config = loadConfig();
const semantic = config.semantic;
const useSemanticRerank = semantic?.enabled && semantic?.provider !== "mock";

if (useSemanticRerank && rows.length > 1) {
  // Fast-path: skip if no embeddings exist yet
  const embCount = await countSymbolEmbeddings(conn, request.repoId);
  if (embCount > 0) {
    const reranked = await rerankByEmbeddings({
      query: request.query,
      symbols: rows.map((row, i) => ({
        symbol: row,
        lexicalScore: 1.0 - (i / rows.length),
      })),
      provider: semantic.provider,
      alpha: semantic.alpha ?? 0.6,
      model: semantic.model,
    });
    rows = reranked.map(r => r.symbol); // replace with reranked order
  }
}
```

### 5b. Add embedding count query

**File: `src/db/ladybug-embeddings.ts`**

```typescript
export async function countSymbolEmbeddings(conn: Connection, repoId: string): Promise<number>
```

Cypher: count `SymbolEmbedding` nodes whose symbolId matches symbols in the given repo.

### 5c. Update telemetry

**File: `src/mcp/tools/symbol.ts`**

Change `semanticEnabled: false` → dynamically set based on whether reranking was applied.

---

## Phase 6 — nomic-embed-code Support (Medium Tier)

nomic-embed-code-v1 is the middle-ground option: it was trained on code so it natively understands code patterns, identifiers, and structural relationships — producing significantly better embeddings from raw symbol text than MiniLM can. Users who want better-than-baseline quality without spending API tokens on LLM summaries should use this tier.

### 6a. nomic model metadata

**File: `src/indexer/model-registry.ts`**

Add nomic entry with download URLs:
- `https://huggingface.co/nomic-ai/nomic-embed-code-v1/resolve/main/onnx/model.onnx`
- `https://huggingface.co/nomic-ai/nomic-embed-code-v1/resolve/main/tokenizer.json`
- `https://huggingface.co/nomic-ai/nomic-embed-code-v1/resolve/main/config.json`

The `tokenizers` napi package handles both WordPiece (MiniLM) and BPE (nomic) — same `Tokenizer.fromFile()` API, no code changes needed.

### 6b. Config interaction with `generateSummaries`

When `model: "nomic-embed-code-v1"` is set, `generateSummaries` is **ignored** even if `true` — nomic doesn't benefit from LLM summaries because it already understands code. The pipeline logs an info message explaining this:

```
[info] nomic-embed-code-v1 selected — skipping LLM summary generation (model understands code natively)
```

If a user later switches back to MiniLM with `generateSummaries: true`, the Anthropic summary pipeline activates normally.

### 6c. Download management

Add to `src/cli/commands/doctor.ts`:
- Check for model availability under the semantic models doctor check
- For nomic: report WARN if model not downloaded, with download instructions

Handle automatically on first use in `model-downloader.ts` — when `createOnnxSession("nomic-embed-code-v1")` is called and the model isn't cached, download it with progress logging. Also consider a CLI command `sdl-mcp model download nomic-embed-code-v1` for users who want to pre-download.

---

## Phase 7 — Doctor & Testing

### 7a. Doctor check

**File: `src/cli/commands/doctor.ts`**

New check `checkSemanticModels`:
- PASS: onnxruntime-node available + configured model files present
- WARN: onnxruntime-node missing (falls back to mock automatically)
- WARN: nomic configured but not downloaded
- INFO: report active model, dimension, ANN status

### 7b. Unit tests

**New: `tests/unit/model-registry.test.ts`**
- Model info lookup for known models
- Path resolution (bundled vs cache)

**New: `tests/unit/embeddings-local.test.ts`**
- Mock the ONNX session to test the pipeline without native deps
- Verify mean pooling logic independently
- Verify batch processing and padding

### 7c. Integration tests

**New: `tests/integration/semantic-embedding.test.ts`** (skip if no onnxruntime)
- Load bundled MiniLM, embed known strings
- Assert dimension = 384, vectors normalized
- Assert similar strings have higher cosine similarity
- Test full `rerankByEmbeddings()` changes result order

**New: `tests/integration/search-semantic-rerank.test.ts`** (skip if no onnxruntime)
- Index a test repo with real embeddings
- Run `handleSymbolSearch()`, verify reranking applied

### 7d. Graceful degradation

If `onnxruntime-node` or `tokenizers` is not installed:
- `createOnnxSession()` throws with a clear error message
- `LocalEmbeddingProvider` catches this and falls back to `MockEmbeddingProvider` with a warning log
- Search still works (lexical only), no crash
- Doctor reports the degradation

---

## Files Changed (Summary)

| File | Change |
|---|---|
| **New** `src/indexer/model-registry.ts` | Model metadata, path resolution |
| **New** `src/indexer/model-downloader.ts` | On-demand model download for nomic |
| **New** `scripts/download-models.mjs` | Dev script to fetch bundled model files |
| **New** `models/all-MiniLM-L6-v2/*` | Bundled ONNX model + tokenizer + config |
| **Rewrite** `src/indexer/embeddings-local.ts` | Full ONNX inference engine |
| **Modify** `src/indexer/embeddings.ts` | Dynamic dims, real LocalProvider, richer text construction |
| **Modify** `src/indexer/ann-index.ts` | Remove hardcoded EMBEDDING_DIMENSION |
| **Modify** `src/indexer/metrics-updater.ts` | Reorder pipeline: summaries → embeddings → ANN |
| **Modify** `src/mcp/tools/symbol.ts` | Wire `rerankByEmbeddings()` into search |
| **Modify** `src/config/types.ts` | New defaults (local, ann.enabled), model enum, modelCacheDir |
| **Modify** `src/db/ladybug-embeddings.ts` | Add `countSymbolEmbeddings()` |
| **Modify** `config/sdlmcp.config.schema.json` | Mirror config changes |
| **Modify** `config/sdlmcp.config.example.json` | Update example defaults |
| **Modify** `package.json` | Add `tokenizers` optional dep, `models` to files array |
| **Modify** `src/cli/commands/doctor.ts` | Semantic model health check |
| **New** `tests/unit/model-registry.test.ts` | Unit tests |
| **New** `tests/unit/embeddings-local.test.ts` | Unit tests |
| **New** `tests/integration/semantic-embedding.test.ts` | Integration tests |
| **New** `tests/integration/search-semantic-rerank.test.ts` | Integration tests |

---

## Verification

### All tiers
1. **Build**: `npm run build:all` — clean compile with no type errors
2. **Doctor**: `sdl-mcp doctor` — reports semantic model status (PASS for MiniLM)
3. **ANN**: Verify ANN index built automatically after indexing (log output shows indexed count)
4. **Degradation**: Temporarily remove `onnxruntime-node` → verify search still works (lexical fallback, warning logged)
5. **Tests**: `npm test` passes (unit tests mock ONNX), integration tests pass when onnxruntime available

### Low tier (default — MiniLM on raw text)
6. **Index**: `sdl-mcp index` on a test repo — observe embedding generation in logs (384-dim vectors, not 64-dim hashes)
7. **Search**: `sdl.symbol.search` — verify reranked results differ from pure lexical order; check telemetry shows `semanticEnabled: true`

### Medium tier (nomic-embed-code on raw text)
8. **Config**: Set `model: "nomic-embed-code-v1"` → first index triggers model download (~274MB)
9. **Index**: Observe 768-dim vectors in logs, `generateSummaries` skipped even if `true` (info log confirms)
10. **Quality**: Search results should show improved relevance over low tier for code-specific queries (e.g., searching "authentication" finds `validateCredentials`)

### High tier (LLM summaries + MiniLM)
11. **Config**: Set `model: "all-MiniLM-L6-v2"`, `generateSummaries: true` + `ANTHROPIC_API_KEY`
12. **Pipeline order**: Verify summaries generated BEFORE embeddings — check logs show summary batch then embedding batch
13. **Quality**: Embedding text uses LLM summary content (not raw symbol text) — best semantic search results
