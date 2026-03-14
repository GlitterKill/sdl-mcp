# Sandboxed Runtime Execution

[Back to README](../../README.md)

---

## Run Code Under Governance

`sdl.runtime.execute` lets AI agents run tests, linters, build scripts, and diagnostic commands within SDL-MCP's governance framework, rather than through uncontrolled shell access.

---

## Security Model

```
  Agent: "Run the test suite"
       │
       ▼
  ┌──────────────────────────────────────────┐
  │            Governance Layer              │
  │                                          │
  │  1. Feature gate ── enabled in config?   │
  │  2. Policy check ── runtime allowed?     │
  │  3. Executable validation ── on allowlist?│
  │  4. CWD jailing ── within repo root?     │
  │  5. Env scrubbing ── secrets removed?    │
  │  6. Concurrency cap ── slots available?  │
  └──────────────┬───────────────────────────┘
                 │
          All checks pass
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │           Sandboxed Subprocess           │
  │                                          │
  │  • Runs in repo directory                │
  │  • Clean environment (PATH only)         │
  │  • Hard timeout with process-tree kill   │
  │  • Stdout/stderr captured with limits    │
  │  • Exit code + signal recorded           │
  └──────────────┬───────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │           Response Processing            │
  │                                          │
  │  • Head + tail stdout summary            │
  │  • Stderr summary                        │
  │  • Keyword-matched excerpt windows       │
  │  • Full output persisted as gzip artifact│
  │  • Audit trail entry created             │
  └──────────────────────────────────────────┘
```

### Supported Runtimes

| Runtime | Default Executable | Use Cases |
|:--------|:-------------------|:----------|
| `node` | `node` (or `bun`) | Running tests, scripts, build tools |
| `python` | `python3` / `python` (Windows) | Linters, analysis scripts, data processing |
| `shell` | `bash` / `cmd.exe` (Windows) | General shell commands, git operations |

### Two Execution Modes

1. **Args mode**: Run a command with arguments
   ```json
   { "runtime": "node", "args": ["--test", "tests/auth.test.ts"] }
   ```

2. **Code mode**: Execute inline code (written to a temp file, cleaned up after)
   ```json
   { "runtime": "node", "code": "console.log(process.versions)" }
   ```

### Smart Output Handling

Raw subprocess output can be enormous. SDL-MCP processes it:

- **Head + tail summary**: First and last N lines of stdout (configurable via `maxResponseLines`)
- **Keyword excerpts**: If you provide `queryTerms`, SDL-MCP finds matching lines and returns windowed excerpts around them
- **Artifact persistence**: Full output saved as gzip with SHA-256 hash, TTL, and size limits

---

## Configuration

```jsonc
{
  "runtime": {
    "enabled": false,          // must explicitly enable
    "allowedRuntimes": ["node", "python", "shell"],
    "maxDurationMs": 30000,    // 30 second default timeout
    "maxConcurrentJobs": 2,    // prevent resource exhaustion
    "maxOutputBytes": 1048576  // 1MB output cap
  }
}
```

---

## Related Tools

- [`sdl.runtime.execute`](../mcp-tools-detailed.md#sdlruntimeexecute) - Full parameter reference
- [Governance & Policy](./governance-policy.md) - Policy engine details

[Back to README](../../README.md)
