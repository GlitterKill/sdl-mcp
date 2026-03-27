# Synthetic Benchmark (Replay Traces)

The synthetic benchmark is replay-trace based. It summarizes token reduction from traces recorded from real-world benchmark outputs.

## Usage

```bash
# Run synthetic replay benchmark
npm run benchmark -- --repo-id my-repo

# Emit machine-readable JSON to stdout
npm run benchmark -- --repo-id my-repo --json

# Save report file
npm run benchmark -- --repo-id my-repo --out benchmarks/synthetic/results.json
```

## Refresh Replay Traces

```bash
npm run benchmark:record-trace -- --input benchmarks/real-world/results-current.json --tasks benchmarks/real-world/tasks.json --out benchmarks/synthetic/replay-traces.json
```

Keep replay traces fresh whenever `benchmarks/real-world/results-current.json` changes.
