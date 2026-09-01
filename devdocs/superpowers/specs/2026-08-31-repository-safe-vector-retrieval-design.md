# Repository-Safe Vector Retrieval Design

## Goal

Replace Symbol retrieval through LadybugDB projected HNSW graphs with a responsive repository-safe path: adaptive base-table HNSW followed by a pure exact cosine scan when ANN cannot provide a complete candidate set.

## Constraints

- Change only Symbol vector retrieval. Existing FileSummary and AgentFeedback vector lanes remain unchanged.
- Reuse the physical `SymbolVectorEmbedding` HNSW indexes; do not rebuild or refresh the repository index.
- Never expose or fuse a Symbol until its `SymbolVectorEmbedding.repoId` ownership matches the requested repository. Symbol nodes can be shared across repositories, so their mutable `repoId` property is not an authoritative vector-owner field.
- Preserve the existing vector-query deadline, circuit breaker, connection quarantine, FTS fallback, result types, and public MCP schemas.
- Add no dependency, new configuration surface, or per-repository index lifecycle.

## Selected design

### Adaptive base-table ANN

Query `QUERY_VECTOR_INDEX` against the physical `SymbolVectorEmbedding` table and return only each embedding node's `symbolId`, distance, and a boolean ownership marker for `SymbolVectorEmbedding.repoId = <requested repo>`. No foreign Symbol content reaches TypeScript, and rows whose ownership marker is false are discarded before ranking, evidence, fusion, or public output. Keeping the bounded raw row count lets the caller distinguish an exhausted global window from repository filtering.

Start with the configured `vectorTopK`. If fewer than that many repository-owned rows survive and LadybugDB returned a full global window, make one adaptive retry with twice the global HNSW window, capped by the existing validated stored-procedure maximum of 10,000 candidates. If the retry is still short, use exact fallback. At most two five-second ANN calls can occur, giving this phase a 10-second cumulative worst-case caller budget while keeping the common path to one ANN call when the requested repository dominates the vector corpus. An ANN error or timeout skips the retry and enters exact fallback immediately.

Before returning ANN results, deduplicate by `symbolId`, sort by numeric distance ascending with `symbolId` as the deterministic tie-break, filter on the ownership marker, and truncate to the requested top-K.

### Exact correctness and liveness fallback

Run a repository-filtered exact scan when:

- the HNSW query throws, times out, or is rejected by the vector circuit;
- adaptive ANN reaches its candidate ceiling without enough repository rows;
- ANN returns an unexpectedly short or empty global window before enough repository rows are found.

The exact query scans `SymbolVectorEmbedding`, filters by its repository owner and non-null model vector, computes `array_cosine_similarity`, and orders by score descending with `symbolId` as the deterministic tie-break. It returns only the requested top-K.

If the HNSW deadline quarantined the current connection, acquire another healthy pooled read connection for the exact scan. Otherwise reuse the checked-out connection. Exact scans run through their own process-wide single-flight guard with a five-second caller deadline and 60-second cooldown circuit. This guard bypasses an open ANN circuit, immediately quarantines an exact-scan connection that exceeds its deadline, and keeps its limiter slot until the native query settles. If exact retrieval also fails or its circuit is open, retain the existing graceful degradation: the vector lane returns no ranking and FTS remains available.

## Data flow

```text
physical HNSW -> repository ownership filter -> enough rows? -> return
                                                    |
                                                    no
                                                    v
                                         expand global K (bounded)
                                                    |
                                      failure/shortage/ceiling
                                                    v
                                  exact repository cosine scan -> return
```

## Code boundaries

- `src/retrieval/orchestrator.ts` owns adaptive ANN control flow, scoring, and fallback selection.
- `src/db/ladybug-retrieval.ts` owns the exact repository-scoped cosine query.
- `src/db/ladybug-queries.ts` exports only the new exact-scan adapter; the obsolete Symbol vector projection helper is removed.
- `src/db/ladybug-core.ts` retains the ANN guard and adds the independent exact-vector guard; connection-pool quarantine remains in `src/db/ladybug.ts`.

## Verification

- Unit tests prove the physical table is queried, foreign-repository candidates never enter rankings, one adaptive retry occurs only for a full short window, and exact scan runs on ANN failure, an unexpectedly short window, or unresolved retry shortage.
- Repeatability tests permute duplicate/equal-distance ANN rows and prove stable distance-then-`symbolId` output.
- Liveness tests prove a quarantined ANN connection is not reused for exact fallback, the exact path bypasses the ANN circuit, and a hung exact scan returns after five seconds while quarantining its own connection.
- An isolated LadybugDB test compares exact results with expected repository ownership and deterministic score order.
- Benchmark the exact scan on the disposable real-graph clone, reporting p50/p95 latency and row/vector counts. Do not infer a per-repository-index requirement until this measurement exceeds the accepted retrieval budget.
- Update architecture and semantic retrieval documentation to describe adaptive global ANN plus exact fallback instead of projected HNSW.

## Alternatives rejected

- Keep projected HNSW: the projection-aware query is the observed unbounded native operation.
- Pure exact scan as the primary path: reliable, but unnecessary until its real-graph latency is measured against the working base HNSW.
- Per-repository HNSW tables or database shards: substantially more lifecycle and storage complexity without current benchmark evidence.
- Global HNSW with one fixed over-fetch window: can starve small repositories and has no correctness fallback.
