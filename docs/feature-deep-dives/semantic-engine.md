# The Semantic Engine: How SDL-MCP Understands Your Code

[Back to README](../../README.md)

---

SDL-MCP doesn't just parse syntax — it *understands* your code. Three interconnected subsystems form the **semantic engine**: a multi-language call resolver that traces dependencies with confidence scoring, an embedding-powered search reranker that finds what you mean (not just what you typed), and an LLM summary generator that describes what symbols do in plain English.

This document covers all three in depth, with architecture diagrams, configuration examples, and practical usage patterns.

---

## Table of Contents

1. [Overview: The Three Pillars](#overview-the-three-pillars)
2. [Pass-2 Call Resolution](#pass-2-call-resolution)
3. [Semantic Search & Embeddings](#semantic-search--embeddings)
4. [LLM Symbol Summaries](#llm-symbol-summaries)
5. [Configuration Reference](#configuration-reference)
6. [Practical Examples](#practical-examples)

---

## Overview: The Three Pillars

```
  ┌───────────────────────────────────────────────────────────────────┐
  │                    SDL-MCP Semantic Engine                        │
  │                                                                   │
  │  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
  │  │   Pass-2 Call    │  │    Embedding     │  │  LLM Summary    │  │
  │  │   Resolution     │  │    Search        │  │  Generation     │  │
  │  │                  │  │                  │  │                 │  │
  │  │ "Who calls whom, │  │ "Find what you   │  │ "What does this │  │
  │  │  and how sure    │  │  mean, not just  │  │  symbol actually│  │
  │  │  are we?"        │  │  what you typed" │  │  do?"           │  │
  │  │                  │  │                  │  │                 │  │
  │  │ 11 language      │  │ Local ONNX or    │  │ Claude Haiku,   │  │
  │  │ resolvers        │  │ API embeddings   │  │ Ollama, or mock │  │
  │  │                  │  │                  │  │                 │  │
  │  │ Confidence:      │  │ Alpha-blended    │  │ Cached with     │  │
  │  │ 0.0 - 1.0        │  │ lexical+semantic │  │ content hash    │  │
  │  └────────┬─────────┘  └────────┬─────────┘  └────────┬────────┘  │
  │           │                     │                      │          │
  │           ▼                     ▼                      ▼          │
  │  ┌──────────────────────────────────────────────────────────────┐ │
  │  │                    Symbol Cards & Slices                     │ │
  │  │  Every card benefits: accurate deps, smart search, summaries│ │
  │  └──────────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
```

| Pillar | Runs When | Output | Default State |
|:-------|:----------|:-------|:--------------|
| **Pass-2 Resolution** | Every index (full & incremental) | Confidence-scored call edges | Always on |
| **Embedding Search** | On `sdl.symbol.search` with `semantic: true` | Reranked search results | Enabled, opt-in per query |
| **LLM Summaries** | At index time (if configured) | 1-3 sentence symbol descriptions | Off by default |

---

## Pass-2 Call Resolution

### The Problem with Naive Call Detection

Pass-1 (initial indexing) extracts *raw* call identifiers from AST nodes. When it sees `validateToken(input)`, it records a call to the name `"validateToken"` — but doesn't know *which* `validateToken`. Is it the one from `./auth/jwt.ts`? Or the one from `./utils/validation.ts`? Or a third-party library function?

Pass-2 answers this question by tracing import chains, analyzing scope, and resolving each raw call identifier to a specific `symbolId` with a confidence score.

### Two-Pass Architecture

```
  PASS 1 (per-file, parallelizable)         PASS 2 (cross-file, sequential)
  ──────────────────────────────────         ─────────────────────────────────

  ┌──────────────┐                           ┌──────────────────────────────┐
  │  Parse AST   │                           │  For each file with calls:   │
  │              │                           │                              │
  │  Extract:    │                           │  1. Re-extract symbols       │
  │  • symbols   │                           │  2. Map to indexed symbolIds │
  │  • imports   │  ─────── stored ───────►  │  3. Build import map         │
  │  • raw calls │  (names only, no IDs)     │  4. For each raw call:       │
  │  • types     │                           │     • Check import aliases   │
  │              │                           │     • Check barrel re-exports│
  │              │                           │     • Check same-file scope  │
  │              │                           │     • Check namespace imports│
  │              │                           │     • Check package/module   │
  │              │                           │     • Check global fallback  │
  └──────────────┘                           │  5. Score confidence         │
                                             │  6. Create edge with metadata│
                                             └──────────────────────────────┘
```

### 11 Language Resolvers

The resolver system uses a **registry pattern**. Each language registers a `Pass2Resolver` that knows its own import semantics, scope rules, and naming conventions.

| Language | Resolver | Key Capabilities |
|:---------|:---------|:-----------------|
| **TypeScript** | `TsPass2Resolver` | Import aliases, barrel re-exports, tagged templates, TS compiler integration, namespace imports |
| **JavaScript** | `TsPass2Resolver` | Shared with TypeScript — same module system |
| **Go** | `GoPass2Resolver` | Package indexing, receiver type inference, method resolution on receiver types |
| **Python** | `PythonPass2Resolver` | Module path resolution, relative imports, class method lookup |
| **Java** | `JavaPass2Resolver` | Package-based namespacing, generic type handling, inheritance chain traversal |
| **C#** | `CSharpPass2Resolver` | Namespace resolution, generic types |
| **C** | `CPass2Resolver` | Header-based declarations, function pointer patterns |
| **C++** | `CppPass2Resolver` | Namespace resolution, template functions, method overloads |
| **PHP** | `PhpPass2Resolver` | Namespace resolution, use statements |
| **Rust** | `RustPass2Resolver` | Module system, trait method resolution |
| **Kotlin** | `KotlinPass2Resolver` | Package imports, extension functions |
| **Shell** | `ShellPass2Resolver` | Function calls (limited — shell is loosely typed) |

### Resolution Strategies & Confidence Scores

Every resolved call edge is tagged with a **strategy** and a **confidence score**:

```
  Resolution Strategy         Base Confidence    Description
  ─────────────────────────   ───────────────    ──────────────────────────────────
  exact                       0.92               Direct match via compiler API,
                                                 node ID, or unambiguous import

  heuristic                   0.68 - 0.92        Single candidate by name+kind,
                                                 same-package lookup, receiver
                                                 type inference

  unresolved                  0.20 - 0.35        Multiple candidates or no match
                                                 found; placeholder edge created
```

#### Ambiguity Penalty

When multiple candidate symbols match a call, confidence is penalized:

```
  confidence = max(0, baseline - 0.04 × candidateCount)

  Examples:
  ┌──────────────────────────────────────────────────────┐
  │  1 candidate  →  0.92 (no penalty)                   │
  │  2 candidates →  0.84 (0.92 - 0.08)                  │
  │  5 candidates →  0.72 (0.92 - 0.20)                  │
  │ 10 candidates →  0.52 (0.92 - 0.40, clamped)         │
  └──────────────────────────────────────────────────────┘
```

### What Gets Stored Per Edge

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Edge: buildSlice() ──calls──► getEdgesFrom()              │
  │─────────────────────────────────────────────────────────────│
  │  fromSymbolId:    "sha256:abc..."                           │
  │  toSymbolId:      "sha256:def..."                           │
  │  edgeType:        "call"                                    │
  │  weight:          1.0            (0.5 for unresolved)       │
  │  confidence:      0.92                                      │
  │  resolution:      "exact"                                   │
  │  resolverId:      "pass2-ts"                                │
  │  resolutionPhase: "pass2"                                   │
  │  provenance:      "call:getEdgesFrom"                       │
  └─────────────────────────────────────────────────────────────┘
```

### TypeScript: Deep Resolution Examples

The TypeScript resolver handles the most complex scenarios:

**Import Alias Resolution:**
```typescript
// File: src/handler.ts
import { validateToken as checkToken } from "./auth/jwt.js";

checkToken(input);  // → resolves to validateToken in auth/jwt.ts
                    //   confidence: 0.92 (exact, unambiguous import)
```

**Barrel Re-export Tracing:**
```typescript
// File: src/auth/index.ts
export { validateToken } from "./jwt.js";
export { hashPassword } from "./crypto.js";

// File: src/handler.ts
import { validateToken } from "./auth/index.js";

validateToken(input);  // → resolves through barrel to jwt.ts/validateToken
                       //   confidence: 0.90 (exact, via re-export chain)
```

**Namespace Imports:**
```typescript
import * as auth from "./auth/index.js";

auth.validateToken(input);  // → resolves via namespace map
                            //   confidence: 0.92 (exact)
```

**Tagged Template Literals:**
```typescript
const result = sql`SELECT * FROM users WHERE id = ${userId}`;
// → resolves "sql" as a tagged template call
//   confidence: 0.35-0.50 (lower, runtime-determined)
```

### Resolution Metadata in Symbol Cards

When you request a card with `includeResolutionMetadata: true`, the response includes the full resolution chain:

```json
{
  "callResolution": {
    "minCallConfidence": 0.5,
    "calls": [
      {
        "symbolId": "sha256:abc...",
        "label": "validateToken",
        "confidence": 0.92,
        "resolutionReason": "exact",
        "resolverId": "pass2-ts",
        "resolutionPhase": "pass2"
      },
      {
        "symbolId": "sha256:def...",
        "label": "hashPassword",
        "confidence": 0.72,
        "resolutionReason": "heuristic",
        "resolverId": "pass2-ts",
        "resolutionPhase": "pass2"
      }
    ]
  }
}
```

### Filtering Low-Confidence Edges

Both `sdl.symbol.getCard` and `sdl.slice.build` accept a `minCallConfidence` parameter:

```
  minCallConfidence: 0.5 (default)
  ───────────────────────────────────────
  Keeps:  exact (0.92), strong heuristic (0.72+)
  Drops:  unresolved (0.20-0.35), weak heuristic

  minCallConfidence: 0.8 (precision mode)
  ───────────────────────────────────────
  Keeps:  exact (0.92) only
  Drops:  everything below 0.8

  minCallConfidence: 0.0 (recall mode)
  ───────────────────────────────────────
  Keeps:  everything, including unresolved
```

### Health Metric: `callResolution`

`sdl.repo.status` includes a `callResolution` health component (0.0-1.0) measuring the percentage of call edges that were resolved above the confidence threshold. A score below 0.6 indicates the pass-2 resolver is struggling with the codebase (e.g., heavy dynamic dispatch, missing type information).

---

## Semantic Search & Embeddings

### Beyond Lexical Matching

Standard symbol search is lexical: searching for `"validate"` matches `validateToken`, `validateInput`, `isValid`, etc. — ranked by string similarity. But what if you search for `"check auth credentials"`? Lexical search finds nothing. Semantic search finds `validateToken`, `authenticate`, `verifyPassword` — because it understands *meaning*.

### How It Works

```
  User Query: "check auth credentials"
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │  1. Lexical Search (always runs first)               │
  │     → authenticate, AuthService, checkPermissions,   │
  │       validateToken, ...                             │
  │     Ranked by string similarity                      │
  └─────────────────────┬────────────────────────────────┘
                        │
                        ▼  (if semantic: true)
  ┌──────────────────────────────────────────────────────┐
  │  2. Embed Query                                      │
  │     "check auth credentials" → [0.12, -0.34, ...]   │
  │     384-dim vector (MiniLM) or 768-dim (Nomic)       │
  └─────────────────────┬────────────────────────────────┘
                        │
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  3. Embed Each Symbol                                │
  │     "authenticate (function): Validates JWT token    │
  │      and attaches user to request"                   │
  │      → [0.15, -0.31, ...]                            │
  │                                                      │
  │  4. Cosine Similarity                                │
  │     sim(query, authenticate) = 0.87                  │
  │     sim(query, checkPermissions) = 0.62              │
  │     sim(query, validateToken) = 0.91                 │
  └─────────────────────┬────────────────────────────────┘
                        │
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  5. Alpha Blending                                   │
  │                                                      │
  │  finalScore = α × lexicalScore + (1-α) × semantic    │
  │                                                      │
  │  With α = 0.6 (default):                             │
  │  60% lexical weight + 40% semantic weight            │
  │                                                      │
  │  Result: validateToken rises to #1                   │
  │  (high semantic match + decent lexical match)        │
  └──────────────────────────────────────────────────────┘
```

### Two Embedding Models

SDL-MCP ships with two embedding models, each suited to different workflows:

```
  ┌────────────────────────────────────────────────────────────────┐
  │                    all-MiniLM-L6-v2 (Default)                  │
  │────────────────────────────────────────────────────────────────│
  │  Dimensions:    384                                            │
  │  Max tokens:    256                                            │
  │  Size:          ~22 MB (INT8 quantized ONNX)                   │
  │  Bundled:       YES (included in npm package)                  │
  │  Training:      General sentence embeddings                    │
  │  Best for:      Quick setup, small codebases, free tier       │
  │                                                                │
  │  Text input:  "validateToken (function): Validates JWT         │
  │                signature and checks expiration claim"          │
  │  ▲ Uses LLM summary for rich context                          │
  └────────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────────┐
  │                    nomic-embed-text-v1.5                        │
  │────────────────────────────────────────────────────────────────│
  │  Dimensions:    768                                            │
  │  Max tokens:    8,192                                          │
  │  Size:          ~138 MB (downloaded on first use)              │
  │  Bundled:       NO (fetched from HuggingFace)                  │
  │  Training:      High-quality text embeddings (Matryoshka)      │
  │  Best for:      Better semantic matching, longer context       │
  │                                                                │
  │  Text input:  "validateToken (function): Validates JWT         │
  │                signature and checks expiration claim"          │
  │  ▲ Uses same text format as MiniLM, benefits from summaries   │
  └────────────────────────────────────────────────────────────────┘
```

**Which should you choose?**

| If you... | Use |
|:----------|:----|
| Want zero setup, no downloads | `all-MiniLM-L6-v2` (bundled in npm) |
| Want better quality, longer context | `nomic-embed-text-v1.5` (768-dim, 8192 tokens) |
| Have LLM summaries enabled | Either model benefits from summaries |
| Have a large codebase (>10k symbols) | `all-MiniLM-L6-v2` (smaller vectors = faster ANN) |
| Want the best overall quality | `nomic-embed-text-v1.5` + LLM summaries |

### Three Embedding Providers

| Provider | How It Works | When to Use |
|:---------|:-------------|:------------|
| **`local`** (default) | ONNX runtime on your machine, fully offline | Most users — no API keys needed |
| **`api`** | Anthropic API | Enterprise environments |
| **`mock`** | Deterministic hash-based vectors (64-dim) | Testing, CI, when ONNX is unavailable |

The local provider uses `onnxruntime-node` and `tokenizers` (optional dependencies). If they're not installed, it gracefully falls back to mock embeddings.

### Embedding Storage

Embeddings are stored in LadybugDB as compressed vectors:

```
  Float32 → multiply by 10,000 → round to Int16 → base64 encode

  Storage savings: ~50% vs raw float32
  Precision loss: negligible for cosine similarity
```

Each embedding is tagged with a `cardHash` (SHA-256 of the symbol data + text format used). When the symbol changes or the text format changes, the embedding is automatically refreshed.

### ANN Index (Approximate Nearest Neighbor)

For repos with thousands of symbols, SDL-MCP builds an HNSW index for fast vector similarity search:

```
  Configuration:
  ┌──────────────────────────────┐
  │  ann.enabled:       true     │ ← builds index after embeddings
  │  ann.m:             16       │ ← HNSW graph connectivity
  │  ann.efConstruction: 200     │ ← build-time accuracy
  │  ann.efSearch:       50      │ ← query-time accuracy
  │  ann.maxElements:    200000  │ ← max symbols indexed
  └──────────────────────────────┘
```

### Live Overlay Handling

When files have unsaved edits (via the live buffer system), their symbols may not have embeddings yet. The search flow handles this:

1. **Durable symbols** (saved, indexed): reranked using embeddings
2. **Overlay symbols** (unsaved edits): keep original lexical ranking
3. **Merged result**: reranked durable symbols first, then overlay symbols in original order

This ensures unsaved code always appears in results, just without semantic boosting.

---

## LLM Symbol Summaries

### What They Are

A symbol summary is a 1-3 sentence plain-English description of what a symbol does:

```
  ┌─────────────────────────────────────────────────────────┐
  │  Symbol: buildGraphSlice                                │
  │  Kind:   function                                       │
  │  Summary: "Performs a BFS traversal from entry symbols   │
  │  across the dependency graph, scoring each node by       │
  │  relevance and returning the top-N cards within a        │
  │  configurable token budget."                             │
  └─────────────────────────────────────────────────────────┘
```

These summaries serve two purposes:
1. **For agents**: instant understanding without reading code (Rung 1 of the Iris Gate Ladder)
2. **For embeddings**: richer text input for the MiniLM model, producing better semantic search results

### Generation Pipeline

```
  Indexing completes (pass-1 + pass-2)
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │  For each symbol without a fresh cached summary:     │
  │                                                      │
  │  Input to LLM:                                       │
  │  ┌────────────────────────────────────────────────┐   │
  │  │  System: "Write a 1-3 sentence summary of     │   │
  │  │  what this symbol does. Be specific, not       │   │
  │  │  generic. Focus on behavior, not structure."   │   │
  │  │                                                │   │
  │  │  User:                                         │   │
  │  │  Kind: function                                │   │
  │  │  Name: buildGraphSlice                         │   │
  │  │  Signature: (request: SliceBuildRequest):      │   │
  │  │    Promise<GraphSlice>  [truncated 400 chars]  │   │
  │  │  Heuristic hint: Builds a graph slice from     │   │
  │  │    entry symbols  [truncated 200 chars]        │   │
  │  └────────────────────────────────────────────────┘   │
  │                                                      │
  │  Output: 1-3 sentence summary (max 256 tokens)       │
  └─────────────────────┬────────────────────────────────┘
                        │
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  Cache in LadybugDB:                                 │
  │  Key: SHA-256(name|kind|signature|fingerprint|       │
  │                provider|model)                       │
  │  Value: summary text + provider + model + cost       │
  └──────────────────────────────────────────────────────┘
```

### Three Summary Providers

| Provider | Model (default) | Endpoint | Best For |
|:---------|:----------------|:---------|:---------|
| **`api`** (Anthropic) | `claude-haiku-4-5-20251001` | `api.anthropic.com` | Production (fast, cheap, high quality) |
| **`local`** (OpenAI-compatible) | `gpt-4o-mini` | `localhost:11434` (Ollama) | Offline / air-gapped environments |
| **`mock`** | — | — | Testing, CI pipelines |

### Batch Processing

Summaries are generated in configurable batches with concurrency control:

```
  500 symbols needing summaries
  batchSize = 20 → 25 batches
  maxConcurrency = 5

  ┌─────┬─────┬─────┬─────┬─────┐
  │ B1  │ B2  │ B3  │ B4  │ B5  │  ← 5 batches run in parallel
  └──┬──┘  │     │     │     │
     │     │     │     │     │
  ┌──┴──┬──┴──┬──┴──┬──┴──┬──┴──┐
  │ B6  │ B7  │ B8  │ B9  │ B10 │  ← next 5 after first wave completes
  └─────┴─────┴─────┴─────┴─────┘
     ...  (continues until all 25 batches done)

  Approximate time: 3-5 minutes for 500 symbols
  Approximate cost: ~$0.50 USD (Claude Haiku)
```

### Cache Invalidation

The cache key is a SHA-256 hash of `name | kind | signature | astFingerprint | provider | model`. This means:

| Change | Invalidates Cache? |
|:-------|:------------------:|
| Code body changes (different AST fingerprint) | Yes |
| Signature changes (new parameter) | Yes |
| Rename the symbol | Yes |
| Switch from Haiku to GPT-4o-mini | Yes |
| Whitespace-only change (same fingerprint) | No |
| Unrelated file changes | No |

### Cost Tracking

Every generated summary records its estimated API cost:

```
  estimatedTokens = max(1, ceil(summary.length / 4))
  costUsd = estimatedTokens × $0.000002

  Example: 200-char summary ≈ 50 tokens ≈ $0.0001

  A 1,000-symbol repo ≈ $1.00 for first index
  Incremental re-index: only changed symbols → cents
```

### Summary Compatibility

Both supported embedding models (`all-MiniLM-L6-v2` and `nomic-embed-text-v1.5`) are text-based models that benefit from LLM summaries. When `generateSummaries: true` is set, summaries are generated and embedded for all models, producing higher-quality semantic search results.

---

## Configuration Reference

### Full Semantic Config Block

```jsonc
{
  "semantic": {
    // ── Master Switch ──
    "enabled": true,              // Enable semantic features globally

    // ── Embedding Configuration ──
    "provider": "local",          // "local" (ONNX), "api", or "mock"
    "model": "all-MiniLM-L6-v2", // or "nomic-embed-text-v1.5"
    "modelCacheDir": null,        // Custom model cache directory
    "alpha": 0.6,                 // Lexical/semantic blend (0=pure semantic, 1=pure lexical)

    // ── Summary Configuration ──
    "generateSummaries": false,       // Enable LLM summary generation
    "summaryProvider": null,          // null = inherit from "provider"
    "summaryModel": null,             // null = provider default
    "summaryApiKey": null,            // null = use ANTHROPIC_API_KEY env var
    "summaryApiBaseUrl": null,        // null = provider default
    "summaryMaxConcurrency": 5,       // 1-20, parallel batch workers
    "summaryBatchSize": 20,           // 1-50, symbols per batch

    // ── ANN Index ──
    "ann": {
      "enabled": true,            // Build HNSW index after embedding
      "m": 16,                    // Graph connectivity parameter
      "efConstruction": 200,      // Build-time accuracy
      "efSearch": 50,             // Query-time accuracy
      "maxElements": 200000       // Maximum symbols to index
    }
  }
}
```

### Quick Config Recipes

**Recipe 1: Fully offline (no API keys needed)**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "nomic-embed-text-v1.5",
    "generateSummaries": false
  }
}
```

**Recipe 2: Best quality with Claude Haiku summaries**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "nomic-embed-text-v1.5",
    "generateSummaries": true,
    "summaryProvider": "api",
    "summaryModel": "claude-haiku-4-5-20251001"
  }
}
```
Set `ANTHROPIC_API_KEY` in your environment.

**Recipe 3: Local LLM via Ollama**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryModel": "llama3.2",
    "summaryApiBaseUrl": "http://localhost:11434/v1",
    "summaryApiKey": "ollama"
  }
}
```

**Recipe 4: CI / testing (no dependencies)**
```json
{
  "semantic": {
    "enabled": true,
    "provider": "mock",
    "generateSummaries": false
  }
}
```

---

## Practical Examples

### Example 1: Semantic Search in Action

```bash
# Standard lexical search
sdl.symbol.search({
  repoId: "my-app",
  query: "check auth credentials"
})
# Result: checkPermissions, AuthChecker  (string matches only)

# Semantic search
sdl.symbol.search({
  repoId: "my-app",
  query: "check auth credentials",
  semantic: true
})
# Result: validateToken, authenticate, verifyPassword
#         (understands meaning, not just string matching)
```

### Example 2: Inspecting Call Resolution

```bash
# Get a card with full resolution metadata
sdl.symbol.getCard({
  repoId: "my-app",
  symbolId: "sha256:abc...",
  includeResolutionMetadata: true
})

# Response includes:
# {
#   "callResolution": {
#     "calls": [
#       {
#         "label": "validateToken",
#         "confidence": 0.92,
#         "resolutionReason": "exact",
#         "resolverId": "pass2-ts"
#       },
#       {
#         "label": "logAuditEvent",
#         "confidence": 0.45,
#         "resolutionReason": "heuristic",
#         "resolverId": "pass2-ts"
#       }
#     ]
#   }
# }
```

### Example 3: Filtering Noise with Confidence

```bash
# Precision mode: only high-confidence edges
sdl.slice.build({
  repoId: "my-app",
  taskText: "debug the auth flow",
  minCallConfidence: 0.8,
  budget: { maxCards: 30 }
})
# Slice contains only symbols connected by high-confidence call edges
# No "maybe" dependencies cluttering the context

# Recall mode: see everything, including uncertain edges
sdl.slice.build({
  repoId: "my-app",
  taskText: "debug the auth flow",
  minCallConfidence: 0.0,
  budget: { maxCards: 50 }
})
# Slice includes unresolved calls — useful for finding
# dynamically dispatched dependencies
```

### Example 4: Index with Summaries

```bash
# First, configure summaries in your config file
# Then run an index:
sdl-mcp index --repo-id my-app

# Output:
# [indexing] Extracted 847 symbols from 92 files
# [pass2] Resolved 1,204 call edges (89% exact, 8% heuristic, 3% unresolved)
# [summaries] Generated 312 summaries, 535 cached, 0 failed ($0.62)
# [embeddings] Computed 847 embeddings (all-MiniLM-L6-v2)
# [ann] Built HNSW index (847 vectors, 384 dims)
# [finalize] Version v47 committed
```

### Example 5: Context Summary Using Semantic Data

```bash
# Generate a portable context briefing
sdl.context.summary({
  repoId: "my-app",
  query: "authentication middleware",
  budget: 2000,
  format: "markdown"
})

# Returns a structured briefing with:
# - Key symbols (with LLM summaries!)
# - Dependency graph
# - Risk areas (high fan-in, recent churn)
# - Files touched
# All within the 2,000 token budget
```

### Example 6: Checking Semantic Health

```bash
sdl.repo.status({ repoId: "my-app" })

# Look for:
# {
#   "healthComponents": {
#     "callResolution": 0.89  ← 89% of calls resolved above threshold
#   }
# }
#
# If this is below 0.6, your pass-2 resolver may be struggling.
# Common causes:
# - Heavy use of dynamic dispatch (eval, Proxy, reflection)
# - Missing type information (plain JS without JSDoc)
# - Unusual import patterns not covered by resolvers
```

---

## How the Three Pillars Work Together

The real power emerges when all three pillars reinforce each other:

```
  1. Pass-2 resolves: authenticate() calls validateToken()
                                           │
  2. LLM describes: "Validates JWT         │
     signature and checks expiration"      │
                                           │
  3. Agent searches: "token validation"    │
     Embedding match: validateToken ████████ 0.91
                      authenticate  █████── 0.72
                      checkExpiry   ████─── 0.68

  Result: The agent finds validateToken via semantic search,
          reads its summary to understand it instantly,
          and sees its resolved call edges to trace the auth flow —
          all without reading a single line of source code.
```

This is how SDL-MCP achieves 10-50x token savings: the semantic engine provides *understanding* at the metadata level, so raw code is rarely needed.

---

## Related Documentation

- [Symbol Cards & Indexing](./indexing-languages.md) — How symbols are extracted and enriched
- [Iris Gate Ladder](./iris-gate-ladder.md) — How summaries power Rung 1
- [Graph Slicing](./graph-slicing.md) — How confidence-scored edges shape slices
- [MCP Tools Reference](../mcp-tools-detailed.md) — Full API documentation
- [Configuration Reference](../configuration-reference.md) — All config options

[Back to README](../../README.md)
