# Sandboxed Runtime Execution

[Back to README](../../README.md)

---

## Run Commands Under Governance

`sdl.runtime.execute` lets agents run repo-scoped commands under SDL-MCP policy instead of falling back to unrestricted shell access.

This is the preferred execution path for SDL-enforced agent workflows. In Code Mode, agents should normally call it through `runtimeExecute` inside `sdl.workflow`.

---

## Supported Runtimes (16)

SDL-MCP is Windows-first but supports all major platforms (Windows, Linux, macOS). The following runtimes are supported:

### Interpreted Runtimes

| Runtime | Typical executable | Common uses |
|:--------|:-------------------|:------------|
| `node` | `node` or `bun` | JavaScript tests, scripts, build tooling |
| `typescript` | `tsx` / `ts-node` | TypeScript scripts without pre-compilation |
| `python` | `python3` / `python` | Tests, scripts, analysis, automation |
| `shell` | `bash` / `sh` / `cmd.exe` / `powershell` | General command execution |
| `ruby` | `ruby` | Ruby scripts and tests |
| `php` | `php` | PHP scripts |
| `perl` | `perl` | Perl scripts |
| `r` | `Rscript` | R scripts and analysis |
| `elixir` | `elixir` | Elixir scripts |

### Compiled Runtimes

| Runtime | Build step | Common uses |
|:--------|:-----------|:------------|
| `go` | `go run` | Go programs |
| `java` | `javac` then `java` | Java programs |
| `kotlin` | `kotlinc` then `kotlin` | Kotlin programs |
| `rust` | `rustc` then execute | Rust programs |
| `c` | `gcc` / `cl` then execute | C programs |
| `cpp` | `g++` / `cl` then execute | C++ programs |
| `csharp` | `dotnet-script` / `csc` | C# scripts/programs |

Compiled runtimes use a compile-then-execute workflow: SDL-MCP compiles the source, runs the resulting binary, then cleans up.

---

## Sandboxed Execution Flow

```mermaid
flowchart TD
    Req["sdl.runtime.execute request"]
    G1{"runtime.enabled?"}
    G2{"Runtime in<br/>allowedRuntimes?"}
    G3{"Executable<br/>valid?"}
    G4{"CWD within<br/>repo root?"}
    Scrub["Scrub environment<br/>(PATH + allowlist only)"]
    Spawn["Spawn subprocess<br/>with timeout + output caps"]
    Run["Process executes"]
    Timeout{"Timeout<br/>exceeded?"}
    Kill["Hard kill"]
    Collect["Collect stdout/stderr"]
    Trunc["Truncate + summarize<br/>output"]
    Resp["Return structured response"]
    Deny["DENY:<br/>policy violation"]

    Req --> G1
    G1 -->|No| Deny
    G1 -->|Yes| G2
    G2 -->|No| Deny
    G2 -->|Yes| G3
    G3 -->|Invalid| Deny
    G3 -->|Valid| G4
    G4 -->|Outside repo| Deny
    G4 -->|Inside repo| Scrub
    Scrub --> Spawn
    Spawn --> Run
    Run --> Timeout
    Timeout -->|Yes| Kill
    Timeout -->|No| Collect
    Kill --> Collect
    Collect --> Trunc
    Trunc --> Resp

    style Deny fill:#f8d7da,stroke:#dc3545
    style Resp fill:#d4edda,stroke:#28a745
```

## Security Model

Every runtime request passes through SDL-MCP governance:

1. feature gate: `runtime.enabled`
2. allowed runtime check
3. executable compatibility validation
4. repo-scoped cwd enforcement
5. env scrubbing
6. timeout and output caps
7. concurrency limits

This keeps command execution consistent with SDL policy rather than depending on client-native shell permissions.

---

## Output Modes

`sdl.runtime.execute` supports three output modes via the `outputMode` parameter, controlling how much output is returned in the response:

| Mode | Default | Tokens | What you get |
|:-----|:--------|:-------|:-------------|
| `"minimal"` | **Yes** | ~50 | `{status, exitCode, signal, durationMs, outputLines, outputBytes, artifactHandle}` — no stdout/stderr content |
| `"summary"` | No | ~200-500 | Head + tail output excerpts (legacy default behavior) |
| `"intent"` | No | Variable | Only `queryTerms`-matched excerpts — no head/tail summary |

### Choosing a mode

- **`minimal`** is the new default. Use it when you only need to know whether a command succeeded. Follow up with `sdl.runtime.queryOutput` to search the persisted artifact on demand.
- **`summary`** restores the legacy behavior where head + tail excerpts are returned inline. Useful for short commands where you always want to see the output.
- **`intent`** is ideal when you provide `queryTerms` and only care about matching lines. No head/tail summary is included — only matched excerpts.

### Per-line truncation

All modes now enforce a 500-character per-line cap. Lines exceeding this limit are truncated with a `[truncated]` suffix. This prevents a single long line (e.g., minified JSON) from consuming the entire response budget.

---

## Two-Phase Pattern: Minimal Execute + Query

The recommended workflow for most runtime tasks is a two-phase approach:

1. **Execute with `outputMode: "minimal"`** — run the command and get back a lightweight status response with an `artifactHandle`.
2. **Query with `sdl.runtime.queryOutput`** — search the persisted output artifact for specific terms, retrieving only relevant excerpts.

This pattern minimizes tokens in the common case (command succeeded, move on) while still providing full output access when needed.

```mermaid
sequenceDiagram
    participant Agent
    participant SDL as sdl.runtime.execute
    participant Store as Artifact Store
    participant Query as sdl.runtime.queryOutput

    Agent->>SDL: execute(outputMode: "minimal")
    SDL->>Store: persist stdout/stderr (gzip)
    SDL-->>Agent: {status, exitCode, artifactHandle}
    Note over Agent: Check exitCode — done if 0

    Agent->>Query: queryOutput(artifactHandle, queryTerms)
    Query->>Store: search persisted artifact
    Query-->>Agent: {excerpts: [...]}
```

### Example: Two-phase test run

**Phase 1 — Execute:**

```json
{
  "repoId": "my-repo",
  "runtime": "node",
  "args": ["--test", "tests/auth.test.ts"],
  "outputMode": "minimal",
  "timeoutMs": 30000
}
```

**Response (~50 tokens):**

```json
{
  "status": "failure",
  "exitCode": 1,
  "signal": null,
  "durationMs": 4200,
  "outputLines": 312,
  "outputBytes": 18400,
  "artifactHandle": "runtime-my-repo-1774356909696-fc5aa1f22e33e17c"
}
```

**Phase 2 — Query (only if needed):**

```json
{
  "artifactHandle": "runtime-my-repo-1774356909696-fc5aa1f22e33e17c",
  "queryTerms": ["FAIL", "Error", "AssertionError"],
  "maxExcerpts": 5,
  "contextLines": 3
}
```

**Response:**

```json
{
  "artifactHandle": "runtime-my-repo-1774356909696-fc5aa1f22e33e17c",
  "excerpts": [
    {
      "lineStart": 45,
      "lineEnd": 51,
      "content": "  45| not ok 3 - authenticate() rejects expired tokens\n  46|   ---\n  47|   Error: AssertionError: expected 401 but got 200\n  ...",
      "source": "stdout"
    }
  ],
  "totalLines": 312,
  "totalBytes": 18400,
  "searchedStreams": ["stdout", "stderr"]
}
```

---

## sdl.runtime.queryOutput

Retrieves and searches stored runtime output artifacts on demand. Use this after an `outputMode: "minimal"` execution to inspect specific parts of the output without loading it all into context.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `artifactHandle` | string | Yes | Handle returned by `sdl.runtime.execute` |
| `queryTerms` | string[] | Yes | Keywords to search for in the output |
| `maxExcerpts` | integer | No | Maximum excerpt windows to return (default: 10) |
| `contextLines` | integer | No | Lines of context around each match (default: 3) |
| `stream` | `"stdout"` \| `"stderr"` \| `"both"` | No | Which stream(s) to search (default: `"both"`) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `artifactHandle` | string | Echo of the requested handle |
| `excerpts` | array | Matched windows: `{lineStart, lineEnd, content, source}` |
| `totalLines` | integer | Total lines in the artifact |
| `totalBytes` | integer | Total bytes in the artifact |
| `searchedStreams` | string[] | Streams that were searched |


## Example

```json
{
  "repoId": "my-repo",
  "runtime": "node",
  "args": ["scripts/check.mjs"],
  "outputMode": "summary",
  "timeoutMs": 30000,
  "queryTerms": ["FAIL", "Error"],
  "maxResponseLines": 100
}
```

Example uses:

- `node` / `typescript` for JavaScript/TypeScript tests and scripts
- `python` for test helpers, analysis, and automation
- `go`, `rust`, `java`, `kotlin` for compiled language programs
- `shell` only when a shell wrapper is the right abstraction

---

## Configuration

```jsonc
{
  "runtime": {
    "enabled": true,
    // Default: ["node", "python"]. Add more as needed from the 16 supported runtimes.
    "allowedRuntimes": ["node", "python", "shell"],
    "maxDurationMs": 600000,
    "maxConcurrentJobs": 2,
    "maxStdoutBytes": 1048576,
    "maxStderrBytes": 262144,
    "maxArtifactBytes": 10485760,
    "artifactTtlHours": 24,
    // Whitelist additional executables beyond the runtime defaults
    "allowedExecutables": [],
    // Environment variables passed through to subprocesses
    "envAllowlist": ["NODE_ENV", "DATABASE_URL"]
  }
}
```

For enforced agent setups, this runtime block is generated automatically by:

```bash
sdl-mcp init --client <client> --enforce-agent-tools
```

---

## SDL-First Guidance

When SDL-MCP is configured for agent enforcement:

- prefer `runtimeExecute` in `sdl.workflow` over native shell tools
- prefer the two-phase pattern: `outputMode: "minimal"` then `sdl.runtime.queryOutput` on demand
- prefer structured query terms over dumping large output back to the model
- use `shell` only when a shell is necessary, not as the default runtime

---

## Related Docs

- [`sdl.runtime.execute`](../mcp-tools-detailed.md#sdlruntimeexecute)
- [`sdl.runtime.queryOutput`](../mcp-tools-detailed.md#sdlruntimequeryoutput)
- [Code Mode](./code-mode.md)
- [Governance & Policy](./governance-policy.md)

[Back to README](../../README.md)
