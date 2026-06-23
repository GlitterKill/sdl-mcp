# src/graph/ - Graph Analysis & Slice Building

## OVERVIEW
Read-only graph analysis layer. Builds context slices via beam search, computes clustering (community detection), traces call-chain processes, and manages caching.

## KEY FILES

| File | Purpose |
|------|---------|
| `slice.ts` | Orchestration entry point (coordinates sub-modules) |
| `slice/beam-search-engine.ts` | Core beam search algorithm (1399 lines) |
| `slice/start-node-resolver.ts` | Entry point resolution from 7 signal sources |
| `slice/beam-score-worker.ts` | 5-factor weighted scoring function |
| `slice/slice-serializer.ts` | Wire format serialization + ETag dedup |
| `slice/truncation-handler.ts` | Dynamic card cap tightening |
| `cluster.ts` | Label Propagation Algorithm (LPA) - TS fallback |
| `process.ts` | DFS call-chain tracer - TS fallback |
| `buildGraph.ts` | In-memory graph construction from DB |
| `overview.ts` | RepoOverview generation (stats/directories/full) |
| `score.ts` | Symbol relevance scoring |
| `metrics.ts` | Fan-in/out, churn, test refs computation |
| `cache.ts` | Symbol card LRU cache (2000 entries, 100MB) |
| `sliceCache.ts` | Slice result LRU cache (100 entries, 60s TTL) |
| `prefetch.ts` | Prefetch warm-up on serve start |
| `minHeap.ts` | Binary min-heap for O(log n) frontier |

## CONVENTIONS
- This layer is READ-ONLY: no DB mutations
- Wire format: `compact` (default) vs `standard`
- Budget system: `maxCards` + `maxEstimatedTokens` constrain output
- `minConfidence`: default 0.5, adaptive thresholds tighten toward budget
- Edge weights: call (1.0) > config (0.8) > import (0.6)
- `slice.ts` file + `slice/` directory coexist at same level

## ANTI-PATTERNS
- No DB writes from graph layer
- No rebuilding slices when `slice.refresh` can provide deltas
