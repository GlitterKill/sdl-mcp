# SDL-MCP Test Harness

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Testing Guide](../../docs/TESTING.md)
  - [Troubleshooting](../../docs/troubleshooting.md)
- [Harness README (this page)](./README.md)

</details>
</div>

This directory contains compatibility harnesses that validate SDL-MCP behavior for supported client profiles and language adapters.

## Quick Start

```bash
# Runs adapter harness via package.json
npm run test:harness
```

```bash
# Run dist-first adapter harness directly
npm run build
node dist/tests/harness/adapter-runner.js
```

## What Gets Validated

- Tool discovery and registration shape
- Core MCP workflows (register, index, slice, code, delta)
- Profile compatibility assumptions for agent clients
- Adapter integration expectations

## Key Files

- `tests/harness/adapter-runner.ts`: dist-first adapter harness entrypoint
- `tests/harness/runner.ts`: golden task runner
- `tests/harness/client-assertions.ts`: client profile assertions

## Exit Codes

- `0`: all checks passed
- `1`: one or more checks failed
