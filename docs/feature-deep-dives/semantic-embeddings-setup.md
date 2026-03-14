# Semantic Embeddings: Dependencies & Setup Guide

[Back to README](../../README.md) | [Semantic Engine Deep Dive](./semantic-engine.md) | [Configuration Reference](../configuration-reference.md)

---

SDL-MCP's semantic system has three layers — **embedding models**, **LLM summary generation**, and **pass-2 call resolution** — each with its own dependencies and setup. This guide covers installation, configuration, and verification for every tier and provider.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Semantic Embedding Pipeline                      │
│                                                                     │
│   Symbol Text  ──►  Tokenizer  ──►  ONNX Model  ──►  Embedding     │
│   Construction      (tokenizers)     (onnxruntime)     Vector       │
│                                                                     │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────────┐    │
│   │ all-MiniLM    │   │ nomic-embed   │   │ Mock (fallback)   │    │
│   │ 384-dim       │   │ 768-dim       │   │ 64-dim            │    │
│   │ ~22 MB        │   │ ~274 MB       │   │ Deterministic     │    │
│   │ Bundled       │   │ Downloaded    │   │ No deps needed    │    │
│   └───────────────┘   └───────────────┘   └───────────────────┘    │
│                                                                     │
│   Optional LLM Summaries (enrich embedding input text):             │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────────┐    │
│   │ Anthropic API │   │ Ollama/Local  │   │ Mock              │    │
│   │ Claude Haiku  │   │ gpt-4o-mini   │   │ Heuristic text    │    │
│   └───────────────┘   └───────────────┘   └───────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Required vs Optional Dependencies

| Dependency | npm Package | Version | Required? | Purpose |
|:-----------|:------------|:--------|:----------|:--------|
| ONNX Runtime | `onnxruntime-node` | `^1.24.3` | Optional | Run embedding model inference (CPU) |
| HuggingFace Tokenizer | `tokenizers` | `^0.13.3` | Optional | Tokenize text for ONNX models |
| MiniLM Model | bundled | — | Included | 384-dim general-purpose embeddings |
| Nomic Model | downloaded | — | Optional | 768-dim high-quality text embeddings |
| Anthropic API Key | — | — | Optional | LLM summary generation (High tier) |
| Ollama Server | — | — | Optional | Local LLM summary generation |

**Without the optional dependencies**, SDL-MCP still works — embeddings fall back to a deterministic 64-dim mock. Semantic search will function but with lower quality results.

---

## Quick Setup by Tier

### Tier 1: Low (Free, Bundled — Default)

The default configuration. Uses the bundled MiniLM model with raw symbol text. No LLM summaries.

**Step 1 — Install ONNX dependencies:**

```bash
cd sdl-mcp
npm install onnxruntime-node tokenizers
```

**Step 2 — Verify the bundled model exists:**

```bash
npx sdl-mcp doctor
```

Look for:
```
Semantic embedding models .................. PASS
  onnxruntime-node: 1.24.x
  tokenizers: available
  model: all-MiniLM-L6-v2 (384d, files present)
  ANN index: enabled
```

**Step 3 — Config (optional — this is the default):**

```jsonc
// sdl-mcp.config.json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "all-MiniLM-L6-v2"
  }
}
```

**Step 4 — Index your repository:**

```bash
npx sdl-mcp index --repo my-repo
```

Embeddings are generated during the finalization step of indexing. Subsequent searches with `semantic: true` will use them.

**How text is constructed for MiniLM:**
```
validateToken (function)
(token: string, opts?: ValidateOpts): Promise<DecodedToken>
Validates JWT signature and checks expiration claim
```
Natural language format — name, kind, signature, and summary (if available) joined with newlines.

---

### Tier 2: Medium (Free, Downloaded)

Uses the higher-quality Nomic text embedding model. Better semantic matching thanks to 768 dimensions and an 8,192-token context window (vs MiniLM's 384-dim / 256-token limit). Still fully offline — no LLM API calls needed.

**Step 1 — Install ONNX dependencies (if not already):**

```bash
npm install onnxruntime-node tokenizers
```

**Step 2 — Download the Nomic model (~138 MB):**

Option A — Pre-download via script:
```bash
node scripts/download-models.mjs nomic-embed-text-v1.5
```

Option B — Let SDL-MCP download on first use (automatic):
The model is fetched from HuggingFace on the first embedding call during indexing. No manual step needed, but the first index run will take longer.

**Where files are stored:**

| Platform | Path |
|:---------|:-----|
| Windows | `%LOCALAPPDATA%\sdl-mcp\models\nomic-embed-text-v1.5\` |
| macOS | `~/.cache/sdl-mcp/models/nomic-embed-text-v1.5/` |
| Linux | `~/.cache/sdl-mcp/models/nomic-embed-text-v1.5/` |
| Custom | Set `semantic.modelCacheDir` in config |

**What gets downloaded:**

| File | Source | Size |
|:-----|:-------|:-----|
| `model_quantized.onnx` | [HuggingFace](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx) | ~138 MB |
| `tokenizer.json` | [HuggingFace](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json) | ~700 KB |
| `config.json` | [HuggingFace](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json) | ~1 KB |

**Step 3 — Configure:**

```jsonc
// sdl-mcp.config.json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "nomic-embed-text-v1.5"
  }
}
```

**Step 4 — Re-index to generate new embeddings:**

```bash
npx sdl-mcp index --repo my-repo --mode full
```

A full re-index is needed when switching models because the embedding dimensions change (384 → 768).

**Step 5 — Verify:**

```bash
npx sdl-mcp doctor
```

Look for:
```
Semantic embedding models .................. PASS
  onnxruntime-node: 1.24.x
  tokenizers: available
  model: nomic-embed-text-v1.5 (768d, files present)
  ANN index: enabled
```

**How text is constructed for Nomic:**
```
validateToken (function)
(token: string, opts?: ValidateOpts): Promise<DecodedToken>
Validates JWT signature and checks expiration claim
```
Same natural-language format as MiniLM — both are text models. The Nomic model's 8,192-token window means longer signatures and summaries are captured without truncation.

---

### Tier 3: High (API Tokens Required)

Adds LLM-generated natural-language summaries to either embedding model. Both MiniLM and Nomic are text models that benefit equally from summaries. For maximum quality, pair summaries with `nomic-embed-text-v1.5`. Produces the highest quality semantic search results because the LLM distills code meaning into plain English that embedding models handle well.

Choose one of three LLM providers:

#### Option A: Anthropic API (Claude Haiku)

**Step 1 — Get an API key:**

Sign up at [console.anthropic.com](https://console.anthropic.com) and create an API key.

**Step 2 — Set the API key:**

Option A — Environment variable:
```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
```

Option B — Config file:
```jsonc
{
  "semantic": {
    "summaryApiKey": "sk-ant-api03-..."
  }
}
```

**Step 3 — Configure:**

```jsonc
// sdl-mcp.config.json — use either embedding model; both benefit from summaries
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "nomic-embed-text-v1.5",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001",
    "summaryMaxConcurrency": 5,
    "summaryBatchSize": 20
  }
}
```

> **Tip:** For maximum quality, pair summaries with `nomic-embed-text-v1.5`. For smaller disk footprint, `all-MiniLM-L6-v2` + summaries is also very effective.

**Step 4 — Index (summaries generated during finalization):**

```bash
npx sdl-mcp index --repo my-repo
```

**Cost estimate:** ~$2 per 1M tokens. A typical symbol summary uses ~50-100 input tokens and ~30-50 output tokens. For a 1,000-symbol repository: roughly $0.15–$0.30.

**Default model:** `claude-haiku-4-5-20251001`

Other supported models (any Anthropic model works):
- `claude-sonnet-4-20250514` (higher quality, higher cost)
- `claude-haiku-4-5-20251001` (recommended — best quality/cost ratio)

#### Option B: Ollama (Local, Free)

Run an OpenAI-compatible LLM server locally. No API costs, but requires a machine with enough RAM.

**Step 1 — Install Ollama:**

Download from [ollama.com](https://ollama.com/download) and install for your platform.

**Step 2 — Pull a model:**

```bash
ollama pull llama3.2:3b       # Lightweight (~2GB RAM)
# or
ollama pull qwen2.5-coder:7b  # Better for code (~5GB RAM)
# or
ollama pull gpt-4o-mini       # If available via compatible API
```

**Step 3 — Start the server (if not auto-started):**

```bash
ollama serve
```

Ollama runs an OpenAI-compatible API at `http://localhost:11434/v1` by default.

**Step 4 — Configure:**

```jsonc
// sdl-mcp.config.json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "llama3.2:3b",
    "summaryApiBaseUrl": "http://localhost:11434/v1",
    "summaryMaxConcurrency": 2,
    "summaryBatchSize": 10
  }
}
```

> Lower `summaryMaxConcurrency` (2-3) and `summaryBatchSize` (10) for local models to avoid overwhelming a single GPU/CPU.

**Step 5 — Index:**

```bash
npx sdl-mcp index --repo my-repo
```

#### Option C: Any OpenAI-Compatible API

Any server implementing the `/v1/chat/completions` endpoint works — LM Studio, vLLM, text-generation-inference, etc.

**Configure:**

```jsonc
{
  "semantic": {
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "your-model-name",
    "summaryApiKey": "your-api-key",
    "summaryApiBaseUrl": "http://your-server:8080/v1"
  }
}
```

The `summaryProvider: "local"` value sends OpenAI-format requests (`POST /chat/completions`) to the configured base URL.

---

## Model Comparison

```
┌──────────────────────────────────────────────────────────────────┐
│                        Embedding Models                          │
├──────────────────────┬───────────────────────┬───────────────────┤
│                      │  all-MiniLM-L6-v2     │ nomic-embed-      │
│                      │  (Default)            │ text-v1.5         │
├──────────────────────┼───────────────────────┼───────────────────┤
│ Dimensions           │ 384                   │ 768               │
│ Max input tokens     │ 256                   │ 8,192             │
│ ONNX file size       │ ~22 MB (INT8)         │ ~138 MB (INT8)    │
│ Bundled with npm     │ YES                   │ NO (downloaded)   │
│ Training data        │ English sentences     │ Diverse text       │
│ Input format         │ Natural language      │ Natural language   │
│ Best paired with     │ LLM summaries         │ LLM summaries     │
│ Disk location        │ <pkg>/models/         │ <cache>/models/   │
│ HuggingFace source   │ sentence-transformers │ nomic-ai           │
├──────────────────────┴───────────────────────┴───────────────────┤
│                                                                  │
│  "Max input tokens" is the model's context window.               │
│  Text longer than this is truncated before inference.            │
│  MiniLM's 256-token limit is why LLM summaries help most —      │
│  a concise summary fits; raw code bodies get chopped.            │
│                                                                  │
│  Nomic's 8,192-token window can ingest entire signatures,       │
│  doc comments, and moderate function bodies without loss.        │
│  Both models benefit from summaries, but Nomic + summaries      │
│  is the highest-quality combination.                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## Summary Provider Comparison

| Provider | Config value | Default model | Endpoint | Auth | Cost |
|:---------|:-------------|:--------------|:---------|:-----|:-----|
| **Anthropic** | `"api"` | `claude-haiku-4-5-20251001` | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` or `summaryApiKey` | ~$2/1M tokens |
| **Ollama / Local** | `"local"` | `gpt-4o-mini` | `http://localhost:11434/v1/chat/completions` | Optional (default: `"ollama"`) | Free (local compute) |
| **Mock** | `"mock"` | — | None | None | Free |

**API format differences:**
- `"api"` sends Anthropic Messages API format (`x-api-key` header, `anthropic-version` header)
- `"local"` sends OpenAI Chat Completions format (`Authorization: Bearer` header)

**System prompt used for all providers:**
> "You are a code documentation assistant. Write a 1-3 sentence summary of what this TypeScript/JavaScript symbol does. Be specific, not generic. Focus on behavior, not structure."

---

## Semantic Search: How It Works

When you call `sdl.symbol.search` with `semantic: true`:

```
                          Query: "validate authentication token"
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                                    ▼
            Lexical Search                      Embedding Search
            (BM25-style)                        (Cosine Similarity)
                    │                                    │
                    ▼                                    ▼
            lexicalScore                        semanticScore
            (0.0 - 1.0)                         (0.0 - 1.0)
                    │                                    │
                    └──────────┐    ┌────────────────────┘
                               ▼    ▼
                    finalScore = α × lexical + (1-α) × semantic
                                    │
                                    │  α = 0.6 (default)
                                    │  configurable via semantic.alpha
                                    ▼
                            Reranked Results
```

**Alpha blending formula:**
```
finalScore = 0.6 × lexicalScore + 0.4 × semanticScore
```

Adjust `semantic.alpha` in config:
- `0.0` = pure semantic (embedding similarity only)
- `0.5` = balanced
- `0.6` = default (slight lexical bias — works well in practice)
- `1.0` = pure lexical (disables semantic reranking)

---

## ANN Index Configuration

The HNSW (Hierarchical Navigable Small World) index accelerates nearest-neighbor search over embedding vectors. It's built lazily during indexing and rebuilt incrementally as embeddings change.

```jsonc
{
  "semantic": {
    "ann": {
      "enabled": true,          // Default: true
      "m": 16,                  // Connectivity parameter (4-64, default: 16)
      "efConstruction": 200,    // Build quality (16-500, default: 200)
      "efSearch": 50,           // Search quality (8-256, default: 50)
      "maxElements": 200000     // Max vectors (1K-1M, default: 200K)
    }
  }
}
```

| Parameter | Effect of increasing | Trade-off |
|:----------|:--------------------|:----------|
| `m` | Better recall, more memory | Memory per vector |
| `efConstruction` | Higher index quality | Slower index build |
| `efSearch` | Better search accuracy | Slower search queries |
| `maxElements` | Support more symbols | More memory reserved |

For most repositories (< 50K symbols), the defaults are fine.

---

## Embedding Vector Storage

Vectors are stored in the graph database using Float16 compression:

```
Original:    [0.0234, -0.1567, 0.8901, ...]   (float64, 3072 bytes for 384-dim)
Quantized:   [234, -1567, 8901, ...]           (int16 × 10000 scale)
Stored:      Base64(Int16Array)                 (768 bytes for 384-dim)
```

This reduces storage by ~75% with negligible quality loss. Vectors are L2-normalized after decompression.

---

## Summary Caching & Invalidation

LLM-generated summaries are cached in the `SummaryCache` graph table. Cache keys are computed as:

```
cardHash = SHA256(symbolName | kind | signature | astFingerprint | providerName | modelName)
```

**A cache entry invalidates when:**
- The symbol's code changes (new `astFingerprint`)
- The symbol's signature changes
- The configured provider or model changes
- The symbol is deleted

**Cache entries survive:**
- Whitespace-only changes (stable fingerprint)
- Unrelated file edits
- Server restarts (persisted in graph DB)

---

## Troubleshooting

### "Embeddings will fall back to deterministic mock vectors"

**Cause:** `onnxruntime-node` or `tokenizers` not installed.

**Fix:**
```bash
npm install onnxruntime-node tokenizers
```

Then run `npx sdl-mcp doctor` to verify.

### "Bundled model files not found"

**Cause:** The `models/all-MiniLM-L6-v2/` directory is missing from the package.

**Fix:**
```bash
node scripts/download-models.mjs all-MiniLM-L6-v2
```

### "Failed to download model_quantized.onnx for model nomic-embed-text-v1.5"

**Cause:** Network error during HuggingFace download. Possibly behind a proxy or firewall.

**Fix — manual download:**
```bash
# Download files manually and place in cache directory:
# Windows: %LOCALAPPDATA%\sdl-mcp\models\nomic-embed-text-v1.5\
# Linux/Mac: ~/.cache/sdl-mcp/models/nomic-embed-text-v1.5/

curl -L -o model_quantized.onnx "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx"
curl -L -o tokenizer.json "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json"
curl -L -o config.json "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json"
```

Or point to a custom cache directory:
```jsonc
{
  "semantic": {
    "modelCacheDir": "/path/to/your/models"
  }
}
```

### "Local embedding provider falling back to mock"

**Cause:** ONNX session creation failed. Could be missing model files, incompatible onnxruntime version, or corrupted download.

**Fix:**
1. Run `npx sdl-mcp doctor` to identify what's missing
2. Re-download the model: `node scripts/download-models.mjs <model-name>`
3. If onnxruntime-node won't install (platform issue), use mock mode:
   ```jsonc
   { "semantic": { "provider": "mock" } }
   ```

### "No API key for summary generation"

**Cause:** `summaryProvider: "api"` configured but no key found.

**Fix — set the key:**
```bash
export ANTHROPIC_API_KEY=sk-ant-api03-...
```
Or add `"summaryApiKey": "sk-ant-..."` to the `semantic` config block.

### Summaries not generating with Ollama

**Cause:** Ollama server not running, wrong model name, or wrong port.

**Fix:**
1. Verify Ollama is running: `curl http://localhost:11434/v1/models`
2. Verify your model is pulled: `ollama list`
3. Test manually:
   ```bash
   curl http://localhost:11434/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"Hello"}]}'
   ```
4. Ensure `summaryApiBaseUrl` includes `/v1`: `"http://localhost:11434/v1"`

---

## Configuration Quick Reference

```jsonc
{
  "semantic": {
    // ── Embedding Model ─────────────────────────────────────────
    "enabled": true,                                // Enable semantic search
    "provider": "local",                            // "local" | "api" | "mock"
    "model": "all-MiniLM-L6-v2",                   // or "nomic-embed-text-v1.5"
    "modelCacheDir": null,                          // Override model storage path
    "alpha": 0.6,                                   // Lexical/semantic blend (0-1)

    // ── LLM Summaries ───────────────────────────────────────────
    "generateSummaries": false,                     // Enable LLM summary generation
    "summaryProvider": null,                        // "api" | "local" | "mock" (default: inherit from provider)
    "summaryModel": null,                           // Model name (default: claude-haiku-4-5-20251001 for api)
    "summaryApiKey": null,                          // API key (or use ANTHROPIC_API_KEY env var)
    "summaryApiBaseUrl": null,                      // Custom endpoint (default: Anthropic for api, localhost:11434 for local)
    "summaryMaxConcurrency": 5,                     // Parallel summary requests (1-20)
    "summaryBatchSize": 20,                         // Symbols per batch (1-50)

    // ── ANN Index ───────────────────────────────────────────────
    "ann": {
      "enabled": true,                              // Enable HNSW index
      "m": 16,                                      // Connectivity (4-64)
      "efConstruction": 200,                        // Build quality (16-500)
      "efSearch": 50,                               // Search quality (8-256)
      "maxElements": 200000                         // Max vectors (1K-1M)
    }
  }
}
```

---

## Recommended Configurations

### Small personal project (free, minimal setup)

```jsonc
{
  "semantic": {
    "enabled": true,
    "model": "all-MiniLM-L6-v2"
  }
}
```

### Large codebase, better quality (free, ~138 MB download)

```jsonc
{
  "semantic": {
    "enabled": true,
    "model": "nomic-embed-text-v1.5"
  }
}
```

### Production team with API budget (highest quality)

```jsonc
{
  "semantic": {
    "enabled": true,
    "model": "nomic-embed-text-v1.5",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001",
    "summaryMaxConcurrency": 5
  }
}
```

### Air-gapped environment with local LLM

```jsonc
{
  "semantic": {
    "enabled": true,
    "model": "nomic-embed-text-v1.5",
    "modelCacheDir": "/shared/models",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "qwen2.5-coder:7b",
    "summaryApiBaseUrl": "http://gpu-server:11434/v1",
    "summaryMaxConcurrency": 2
  }
}
```

---

## Related Documentation

- [Semantic Engine Deep Dive](./semantic-engine.md) — pass-2 resolution, embedding search, and LLM summaries working together
- [Indexing & Languages](./indexing-languages.md) — two-pass architecture, 12-language support, LLM summary tiers
- [Configuration Reference](../configuration-reference.md) — complete config schema
- [CLI Reference](../cli-reference.md) — `sdl-mcp doctor`, `sdl-mcp index` commands

[Back to README](../../README.md)
