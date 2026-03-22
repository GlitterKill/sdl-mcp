# Sandboxed Runtime Execution

[Back to README](../../README.md)

---

## Run Commands Under Governance

`sdl.runtime.execute` lets agents run repo-scoped commands under SDL-MCP policy instead of falling back to unrestricted shell access.

This is the preferred execution path for SDL-enforced agent workflows. In Code Mode, agents should normally call it through `runtimeExecute` inside `sdl.chain`.

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

## Example

```json
{
  "repoId": "my-repo",
  "runtime": "node",
  "args": ["scripts/check.mjs"],
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
    "maxDurationMs": 30000,
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

- prefer `runtimeExecute` in `sdl.chain` over native shell tools
- prefer structured query terms over dumping large output back to the model
- use `shell` only when a shell is necessary, not as the default runtime

---

## Related Docs

- [`sdl.runtime.execute`](../mcp-tools-detailed.md#sdlruntimeexecute)
- [Code Mode](./code-mode.md)
- [Governance & Policy](./governance-policy.md)

[Back to README](../../README.md)
