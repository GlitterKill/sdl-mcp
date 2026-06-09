# Provider-first fallback benchmark

Use this benchmark for fast provider-first fallback indexing iteration before a larger validation run. It creates a deterministic, representative source-file subset, runs provider-first indexing against that subset, and stores every config, log, file list, and parsed metric under one artifact directory.

The subset is an optimization loop, not release proof. After a candidate change wins here, run either a larger representative subset or the full target repository index before calling the optimization complete.

Selection reserves bounded lanes for known fallback-heavy files from `--priority-file-list` and SCIP-backed provider documents from configured `scip.indexes`, then fills the rest by stable path-group round robin. This keeps tiny smoke runs from accidentally selecting zero provider documents and keeps larger runs from being dominated entirely by the priority list.

## Command

Build current runtime first so the CLI and benchmark use the same code:

```powershell
npm run build:runtime
npm run benchmark:provider-first-fallback -- --config .tmp/llvm-provider-first-smoke.config.json --repo-id llvm --sample-size 8000 --seed llvm-provider-first-v1 --priority-file-list .tmp/llvm-semantic-fallback-files.json --repeats 3 --out-dir devdocs/benchmarks/provider-first-fallback/llvm-baseline
```

Useful options:

- `--sample-size`: target subset size. Keep routine tuning in the 5,000-10,000 file range.
- `--seed`: stable selector seed. Change only when intentionally creating a new comparison lane.
- `--priority-file-list`: optional JSON or text list of fallback-heavy files to bias into the subset. The selector caps this lane at 40% of the sample so provider-backed files and representative path groups still appear.
- `--repeats`: repeat count. Use at least 3 when runs are cheap enough; compare medians.
- `--max-legacy-fallback-files`: override the generated temp config cap. Defaults to at least the selected subset size.
- `--pass2-concurrency`: override `indexing.pass2Concurrency` in the generated temp config for repeatable resolver/write-limiter strategy trials.

## Artifacts

Each run directory contains:

- `source-files.txt` and `source-files.json`: exact deterministic subset.
- `selection.json`: seed, candidate count, selected count, priority/provider candidate counts, selected lane counts, lane targets, and path/language group distribution.
- `repeat-N.config.json`: isolated temp config with `sourceFileListPath` and per-run graph DB path.
- `repeat-N.stdout.log` and `repeat-N.stderr.log`: raw CLI output.
- `repeat-N.metrics.json`: parsed wall time, provider-first total, provider-primary/scanned counts, fallback count/time, fallback engine mode, legacy fallback phase buckets, pass-2 resolver counters when emitted, and warning/error counts.
- `summary.json`: median timing summary across repeats.

## Correctness Signals

Track these before and after each optimization:

- `providerPrimaryFiles / scannedFiles`
- `fallbackFiles`
- `providerUnusableFiles`
- `warningCount` and `errorCount`
- `providerFirstTotalMs`
- `fallbackTotalMs`
- `fallbackEngine` and `legacyFallbackPhases`
- `pass2Resolvers[].cumulativeMs` for resolver-bucket comparisons. This is cumulative resolver work across concurrent targets, not pass-2 wall time.
- `wallTimeMs`

For LadybugDB query, transaction, schema, graph materialization, or write batching changes, get `ladybug-db-expert` review before continuing optimization.

## Final Gate

A subset win is only a candidate. Final validation must include a larger representative subset or the full 65,000+ file target with the same correctness signals recorded to artifacts.

Current LLVM benchmark evidence is recorded in [provider-first-fallback-results-2026-06-08](./provider-first-fallback-results-2026-06-08.md).
