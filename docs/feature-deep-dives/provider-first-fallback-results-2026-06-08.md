# Provider-first fallback benchmark results - 2026-06-08

## Scope

Repository: `F:/Claude/projects/llvm-project`

Config: `.tmp/llvm-provider-first-smoke.config.json`

Priority file list: `.tmp/llvm-semantic-fallback-files.json`

The benchmark uses `repo.sourceFileListPath` to constrain the source scan and provider fact retention to a deterministic subset. Subset runs disable active provider-row reuse and shadow activation so they cannot masquerade as complete graph builds.

## Measurements

| Artifact | Sample | Seed | Wall time | Provider-primary | Fallback files | Warnings | Errors | Key timing |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `.tmp/provider-first-benchmark-script-smoke5` | 5 | `smoke-provider-mix-v1` | 116,063ms | 2/5 | 3 | 0 | 0 | `symbolStatusNormalize=95,202ms` |
| `.tmp/provider-first-benchmark-script-smoke6` | 5 | `smoke-provider-mix-v1` | 13,989ms | 2/5 | 3 | 0 | 0 | `symbolStatusNormalize=80ms` |
| `.tmp/provider-first-benchmark-script-smoke20` | 20 | `smoke-provider-mix-v1` | 12,501ms | 8/20 | 12 | 0 | 0 | `symbolStatusNormalize=97ms` |
| `.tmp/provider-first-benchmark-llvm-1000-final` | 1,000 | `llvm-provider-first-v1` | 1,228,638ms | 405/1,000 | 595 | 0 | 0 real errors | `materialize=724,294ms`, `legacy=496,305ms` |
| `.tmp/provider-first-benchmark-llvm-1000-materialize1` | 1,000 | `llvm-provider-first-v1` | 244,125ms | 405/1,000 | 595 | 0 | 0 | `materialize=~10s`, `legacy=234,120ms` |
| `.tmp/provider-first-benchmark-llvm-1000-pass2c8` | 1,000 | `llvm-provider-first-v1` | 1,327,837ms | 405/1,000 | 595 | 0 | 0 | rejected: `pass2Concurrency=8` regressed wall time |
| `.tmp/provider-first-benchmark-llvm-1000-resolverdiag1` | 1,000 | `llvm-provider-first-v1` | 276,210ms | 405/1,000 | 595 | 0 | 0 | measurement-only: added `pass2.resolvers`; `pass2-cpp` dominated cumulative resolver work |
| `.tmp/provider-first-benchmark-llvm-1000-cppbucket1` | 1,000 | `llvm-provider-first-v1` | 264,621ms | 405/1,000 | 595 | 0 | 0 | rejected: C++ call bucketing was not a reliable wall-time win |
| `.tmp/provider-first-benchmark-llvm-1000-cppnamespace1` | 1,000 | `llvm-provider-first-v1` | 274,299ms | 405/1,000 | 595 | 0 | 0 | rejected: cached namespace-member index lost on wall time |
| `.tmp/provider-first-benchmark-llvm-1000-cppbucket2` | 1,000 | `llvm-provider-first-v1` | 288,457ms | 405/1,000 | 595 | 0 | 0 | rejected confirmation run; parsed `pass2Resolvers` in metrics |
| `.tmp/provider-first-benchmark-llvm-1000-copy128-1` | 1,000 | `llvm-provider-first-v1` | 306,952ms | 405/1,000 | 595 | 0 | 0 | rejected: `PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD=128` worsened `writeActive` |
| `.tmp/provider-first-benchmark-llvm-1000-pass1default-1` | 1,000 | `llvm-provider-first-v1` | failed at 51,955ms | n/a | n/a | 0 | 0 | rejected: default native pass-1 scheduling crashed with exit `3221225477` |
| `.tmp/provider-first-benchmark-llvm-1000-cppdir1` | 1,000 | `llvm-provider-first-v1` | 206,268ms | 405/1,000 | 595 | 0 | 0 | rejected pending confirmation: same-directory C++ index precompute looked fast once but did not reduce resolver cumulative time |
| `.tmp/provider-first-benchmark-llvm-1000-cppdir2` | 1,000 | `llvm-provider-first-v1` | 275,011ms | 405/1,000 | 595 | 0 | 0 | rejected confirmation run: same-directory C++ index precompute lost on wall time |
| `.tmp/provider-first-benchmark-llvm-1000-pass2c2-1` | 1,000 | `llvm-provider-first-v1` | 333,497ms | 405/1,000 | 595 | 0 | 0 | rejected: `pass2Concurrency=2` worsened `pass2.writeActive` to 106,742ms |
| `.tmp/provider-first-benchmark-llvm-1000-pass2batch32k-1` | 1,000 | `llvm-provider-first-v1` | 276,330ms | 405/1,000 | 595 | 0 | 0 | rejected: 256-file/32,768-edge pass-2 flush size cut writeActive only ~4% while wall time regressed |
| `.tmp/provider-first-benchmark-llvm-5000-materialize1` | 5,000 | `llvm-provider-first-v1` | 3,519,348ms | 2,176/5,000 | 2,824 | 0 | 0 | `legacy=3,403,839ms`, `materialize=103,707ms` |
| `.tmp/provider-first-benchmark-llvm-10000-materialize1` | 10,000 | `llvm-provider-first-v1` | 6,503,655ms | 4,302/10,000 | 5,698 | 0 | 0 | final validation: `legacy=6,256,960ms`, `pass2.writeActive=1,704,809ms` |

The same 5-file selector went from 116,063ms to 13,989ms after scoping file-backed symbol-status repair to changed files in benchmark-scoped full runs. That is an 8.3x wall-time improvement for the fast smoke lane.

The first 1,000-file lane completed and preserved representative mix: 405 provider documents, 595 legacy fallback files, 806 semantic-eligible files, and no real stderr errors. The old `errorCount` parser counted filenames containing `Error`; the parser was tightened after this run.

After de-duplicating provider replacement cleanup to one actual-existing-symbol retirement pass, the same 1,000-file selector went from 1,228,638ms to 244,125ms with the same 405 provider-primary files and 595 fallback files. That is a 5.0x wall-time improvement for the representative 1,000-file lane.

## 5,000-file Gate

Initial incomplete artifact: `.tmp/provider-first-benchmark-llvm-5000-final`

The 5,000-file run selected 2,177 provider-backed files and 2,002 priority fallback-heavy files. It reached Pass 2 at 91% after 45 minutes and was stopped. This is not a passing validation gate.

Completed artifact: `.tmp/provider-first-benchmark-llvm-5000-materialize1`

The completed 5,000-file gate selected 5,000 files, retained 2,177 provider docs, produced 2,176 provider-primary files, and sent 2,824 files through legacy fallback. It completed cleanly in 3,519,348ms with no warnings or errors. This proves the deterministic 5,000-file benchmark loop now completes and writes artifacts, but it is still slow enough that further optimization should target the legacy fallback path.

## 10,000-file Validation Gate

Completed artifact: `.tmp/provider-first-benchmark-llvm-10000-materialize1`

The 10,000-file validation selected 10,000 files, including 2,339 priority fallback-heavy files and 4,303 provider-backed files. It produced 4,302 provider-primary files and sent 5,698 files through legacy fallback. It completed cleanly in 6,503,655ms with no warnings or errors.

This validates the implemented benchmark-scoped provider materialization and fallback path beyond the 5,000-file tuning lane. It is not a full 65,000+ file LLVM run, so full-repo behavior can still expose additional path diversity or LadybugDB volume effects, but the larger deterministic gate passed with stable correctness signals.

## Current Bottlenecks

The first bottleneck was repo-wide `finalizeIndexing.symbolStatusNormalize` during benchmark-scoped fallback; scoped file-backed repair reduced it from 95,202ms to 80ms on the same 5-file sample.

At 1,000 files before the materializer cleanup, the bottlenecks moved:

- Provider materialization: 724,294ms total. Reported subphase detail shows `deleteFileSymbols=188,334ms`, with additional transaction/commit or unreported materialization time still unexplained.
- Legacy fallback: 496,305ms total, including `pass1=123,238ms`, `pass2=157,215ms`, and `finalizeIndexing.symbolStatusNormalize=162,601ms`.
- Fallback pass-2 active writes: `writeActive=101,745ms`.

After the materializer cleanup, the 1,000-file bottleneck moved to legacy fallback:

- Legacy fallback: 234,120ms total, including `pass1=95,027ms`, `pass2=120,025ms`, and `finalize=7,555ms`.
- Pass 2 resolver dispatch: 119,763ms.
- Pass 2 active writes: 56,958ms.

The measurement-only resolver diagnostic run showed `pass2-cpp` as the dominant pass-2 resolver bucket: 512 targets, 63,999 edges, and 361,527ms cumulative resolver work, versus 64 C targets, 980 edges, and 10,953ms cumulative work. Cumulative resolver time is summed across concurrent targets and should be compared between resolver buckets, not directly against pass-2 wall time.

Raising `pass2Concurrency` from the default to 8 was tested as a config-only strategy and rejected. The same 1,000-file selector regressed to 1,327,837ms and reintroduced high provider materialization time, so the documented command should keep the default concurrency until the underlying pass-2 write path is improved.

Two C++ resolver strategies were tested and rejected because they did not produce a reliable wall-time win on the same 1,000-file selector:

- C++ call bucketing: 264,621ms first run, then 288,457ms confirmation run after metrics parsing; correctness signals stayed unchanged, but wall time did not beat the 244,125ms materializer-cleanup result.
- Cached namespace-member index: 274,299ms, same correctness signals, slower than the call-bucketing candidate.
- Same-directory symbol index precompute: 206,268ms first run, then 275,011ms confirmation run. The `pass2-cpp` cumulative resolver timer stayed effectively unchanged at ~371s, so the first wall-time win was not a supported bottleneck reduction.

Two pass-2/pass-1 scheduling strategies were also tested and rejected:

- Lowering `PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD` from 512 to 128 was correctness-clean but slower: wall time rose to 306,952ms and `pass2.writeActive` rose to 65,910ms. The DB review interpretation was that 128-row batches pay too much fixed temp CSV plus `COPY DEPENDS_ON FROM` transaction overhead under the current flush shape.
- Disabling provider-first fallback pass-1 stabilization for complete fallback crashed on Windows with exit `3221225477` after reaching pass 1 at 96/595 files. Keep `nativeChunks=serial` and `drainBetweenChunks=on` for this lane until a safer native scheduling change is isolated.
- Raising pass-2 concurrency to 2 regressed wall time to 333,497ms and `pass2.writeActive` to 106,742ms. Raising sequential pass-2 flush limits to 256 files and 32,768 edges was reviewed by `ladybug-db-expert` as a plausible bounded experiment, but the measured run regressed wall time to 276,330ms and only reduced `writeActive` from 56,958ms to 54,769ms, below the 10-15% carry threshold.

At 5,000 files, legacy fallback dominates:

- Legacy fallback: 3,403,839ms total.
- Pass 1: 895,167ms.
- Pass 2: 2,215,687ms.
- Pass 2 resolver dispatch: 2,214,627ms.
- Pass 2 active writes: 979,923ms.
- Provider materialization: 103,707ms, mostly `upsertSymbols=101,219ms`.

At 10,000 files, the same pattern holds:

- Legacy fallback: 6,256,960ms total.
- Pass 1: 1,572,002ms.
- Pass 2: 4,124,439ms.
- Pass 2 resolver dispatch: 4,122,948ms.
- Pass 2 active writes: 1,704,809ms.
- Pass 2 resolver buckets: `pass2-cpp` resolved 3,828 targets and 577,634 edges, `pass2-c` resolved 1,581 targets and 9,562 edges, and `pass2-python` resolved 19 targets and 486 edges with 414 unresolved Python calls.

## Next Work

The harness is now repeatable and artifacted, and the 10,000-file validation gate completes. Next optimization should target legacy fallback pass 2 and active writes, especially C++ resolver dispatch and `writeActive`. Provider materialization is no longer the dominant bottleneck for the 1,000-file lane, but `upsertSymbols` remains visible at 5,000 files.
