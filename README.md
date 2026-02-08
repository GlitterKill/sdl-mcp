# SDL-MCP

Symbol Delta Ledger MCP Server - Cards-first code context for TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell repositories.

SDL-MCP indexes your codebase into semantic symbol cards, enabling AI assistants to understand code structure without reading full files. It provides delta-based updates, policy-governed context selection, and optimized context windows.

## Requirements

- Node.js >= 18.0.0
- npm or yarn
- Git repository (optional but recommended)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd sdl-mcp

# Install dependencies
npm install

# Build the project
npm run build

# (Optional) Install globally for CLI access
npm install -g .
```

## Supported Languages

| Language   | Extensions                                   | Features                                   |
| ---------- | -------------------------------------------- | ------------------------------------------ |
| TypeScript | `.ts`, `.tsx`                                | Full support with type inference           |
| JavaScript | `.js`, `.jsx`                                | Full support                               |
| Python     | `.py`                                        | Functions, classes, methods, decorators    |
| Go         | `.go`                                        | Packages, functions, methods, interfaces   |
| Java       | `.java`                                      | Classes, interfaces, methods, constructors |
| C#         | `.cs`                                        | Namespaces, classes, methods, properties   |
| C          | `.c`, `.h`                                   | Functions, structs, pointers, preprocessor |
| C++        | `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx` | Classes, templates, namespaces, STL        |
| PHP        | `.php`, `.phtml`                             | Classes, functions, namespaces, traits     |
| Rust       | `.rs`                                        | Structs, enums, traits, modules, lifetimes |
| Kotlin     | `.kt`, `.kts`                                | Classes, functions, properties, coroutines |
| Shell      | `.sh`, `.bash`                               | Functions, variables, command execution    |

**Backward Compatibility**: Existing TypeScript/JavaScript-only configurations continue to work without changes. The `languages` field defaults to all supported languages if omitted.

## Quick Start

```bash
# 1. Initialize configuration
sdl-mcp init

# 2. Validate your environment
sdl-mcp doctor

# 3. Index your codebase
sdl-mcp index

# 4. Start the MCP server
sdl-mcp serve --stdio
```

### Language-Specific Quick Starts

#### TypeScript/JavaScript

```bash
sdl-mcp init --languages ts,tsx,js,jsx
sdl-mcp index
```

#### Python

```bash
sdl-mcp init --languages py
sdl-mcp index
```

#### Go

```bash
sdl-mcp init --languages go
sdl-mcp index
```

#### Java

```bash
sdl-mcp init --languages java
sdl-mcp index
```

#### C#

```bash
sdl-mcp init --languages cs
sdl-mcp index
```

#### Polyglot Repository

```bash
# Index all supported languages
sdl-mcp init --languages ts,py,go,java,cs,c,cpp,php,rs,kt,sh
sdl-mcp index
```

## CLI Commands

### `sdl-mcp init`

Initialize SDL-MCP configuration in the current directory.

```bash
sdl-mcp init [options]
```

**Options:**

- `--client <NAME>` - Generate client config for: `claude-code`, `codex`, `gemini`, `opencode`
- `--repo-path <PATH>` - Repository root path (default: current directory)
- `-c, --config <PATH>` - Path to config file (default: `./config/sdlmcp.config.json`)

**Examples:**

```bash
# Initialize with default settings
sdl-mcp init

# Initialize with Claude Code client config
sdl-mcp init --client claude-code

# Initialize for a specific repository
sdl-mcp init --repo-path /path/to/your/repo --client opencode
```

**What it creates:**

- `config/sdlmcp.config.json` - Main configuration file
- `data/sdlmcp.sqlite` - SQLite database (on first run)
- Optional: `<client>-mcp-config.json` - Client-specific MCP configuration

### `sdl-mcp doctor`

Validate SDL-MCP environment and dependencies.

```bash
sdl-mcp doctor [options]
```

**Options:**

- `-c, --config <PATH>` - Path to config file (default: `./config/sdlmcp.config.json`)
- `--log-level <LEVEL>` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `--log-format <FORMAT>` - Log format: `json`, `pretty` (default: `pretty`)

**What it checks:**

- Node.js version (>= 18.0.0)
- Configuration file exists and is readable
- Database path is writable
- Tree-sitter grammars are available for configured languages
- Repository paths are accessible

**Example output:**

```
✓ Node.js version: Node.js v20.11.0 (>= 18.0.0)
✓ Config file exists: /path/to/config/sdlmcp.config.json
✓ Config file readable: /path/to/config/sdlmcp.config.json
✓ Database path writable: SQLite database initialization works
✓ Tree-sitter grammars available: typescript, python, go, java, csharp, c, cpp, php, rust, kotlin, bash
✓ Repo paths accessible: All 1 repo(s) accessible
```

### `sdl-mcp index`

Index repositories to build symbol database.

```bash
sdl-mcp index [options]
```

**Options:**

- `-w, --watch` - Watch for file changes and re-index automatically
- `--repo-id <ID>` - Index specific repository by ID (default: all repos)
- `-c, --config <PATH>` - Path to config file (default: `./config/sdlmcp.config.json`)

**Examples:**

```bash
# Index all configured repositories
sdl-mcp index

# Index specific repository
sdl-mcp index --repo-id my-repo

# Watch for changes and re-index automatically
sdl-mcp index --watch
```

**What it does:**

- Scans configured repositories for supported language files
- Parses files with Tree-sitter to extract symbols
- Builds symbol graph with edges (calls, imports, exports)
- Stores results in SQLite database

**Example output:**

```
Indexing 1 repo(s)...

Indexing my-repo (/path/to/repo)...
  Files: 245
  Symbols: 1842
  Edges: 3421
  Duration: 3421ms
```

### `sdl-mcp serve`

Start the MCP server.

```bash
sdl-mcp serve [options]
```

**Options:**

- `--stdio` - Use stdio transport (default, for MCP clients)
- `--http` - Use HTTP transport for local development
- `--port <NUMBER>` - HTTP port (default: 3000)
- `--host <HOST>` - HTTP host (default: `localhost`)
- `-c, --config <PATH>` - Path to config file (default: `./config/sdlmcp.config.json`)
- `--log-level <LEVEL>` - Log level: `debug`, `info`, `warn`, `error` (default: `info`)
- `--log-format <FORMAT>` - Log format: `json`, `pretty` (default: `pretty`)

**Examples:**

```bash
# Start with stdio transport (for Claude Code, etc.)
sdl-mcp serve --stdio

# Start with HTTP transport for local testing
sdl-mcp serve --http --port 3000

# Start with custom host and port
sdl-mcp serve --http --host 0.0.0.0 --port 8080
```

**What it does:**

- Loads MCP server with all tools registered
- Starts file watchers (if `enableFileWatching: true`)
- Exposes MCP protocol over chosen transport

### `sdl-mcp version`

Show version and environment information.

```bash
sdl-mcp version
```

**Example output:**

```
SDL-MCP version: 0.1.0

Environment:
  Node.js: v20.11.0
  Platform: win32
  Arch: x64
```

## Configuration

SDL-MCP is configured via `config/sdlmcp.config.json`. The file is created automatically by `sdl-mcp init`.

### Configuration Structure

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "/path/to/your/repo",
      "ignore": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      "languages": [
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "go",
        "java",
        "cs",
        "c",
        "cpp",
        "php",
        "rs",
        "kt",
        "sh"
      ],
      "maxFileBytes": 2000000
    }
  ],
  "dbPath": "./data/sdlmcp.sqlite",
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  },
  "redaction": {
    "enabled": true,
    "includeDefaults": true,
    "patterns": []
  },
  "indexing": {
    "concurrency": 4,
    "enableFileWatching": false
  },
  "slice": {
    "defaultMaxCards": 300,
    "defaultMaxTokens": 12000,
    "edgeWeights": {
      "call": 1.0,
      "import": 0.6,
      "config": 0.8
    }
  },
  "diagnostics": {
    "enabled": true,
    "mode": "tsLS",
    "maxErrors": 50,
    "timeoutMs": 2000,
    "scope": "changedFiles"
  }
}
```

### Configuration Sections

**repos** - Repositories to index

- `repoId` (string) - Unique identifier for the repository
- `rootPath` (string) - Absolute path to repository root
- `ignore` (string[]) - Glob patterns for files to exclude
- `languages` (string[]) - File extensions to index: `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh`
- `maxFileBytes` (number) - Maximum file size in bytes (default: 2MB)

**dbPath** (string) - Path to SQLite database file

**policy** - Context governance policies

- `maxWindowLines` (number) - Maximum lines in code windows
- `maxWindowTokens` (number) - Maximum tokens in code windows
- `requireIdentifiers` (boolean) - Require symbol IDs in responses
- `allowBreakGlass` (boolean) - Allow raw file access on request

**redaction** - Sensitive data redaction

- `enabled` (boolean) - Enable redaction
- `includeDefaults` (boolean) - Include default redaction patterns (API keys, emails, etc.)
- `patterns` (array) - Custom redaction patterns

**indexing** - Indexing behavior

- `concurrency` (number) - Number of concurrent indexing workers
- `enableFileWatching` (boolean) - Enable automatic re-indexing on file changes

**slice** - Graph slice configuration

- `defaultMaxCards` (number) - Default maximum cards per slice
- `defaultMaxTokens` (number) - Default maximum tokens per slice
- `edgeWeights` (object) - Weights for different edge types (affects traversal)

**diagnostics** - TypeScript diagnostics integration

- `enabled` (boolean) - Enable diagnostics governor
- `mode` (string) - Diagnostics mode: "tsLS" (TypeScript Language Server)
- `maxErrors` (number) - Maximum errors to include
- `timeoutMs` (number) - Diagnostics timeout in milliseconds
- `scope` (string) - Files to check: "all" or "changedFiles"

### Environment Variables

SDL-MCP can be configured via environment variables:

- `SDL_CONFIG` - Path to configuration file (overrides `-c/--config`)
- `SDL_LOG_LEVEL` - Log level (overrides `--log-level`)
- `SDL_LOG_FORMAT` - Log format (overrides `--log-format`)

## MCP Tools

SDL-MCP exposes the following MCP tools:

- `sdl.repo.register` - Register a new repository
- `sdl.repo.status` - Get repository indexing status
- `sdl.index.refresh` - Trigger repository re-indexing
- `sdl.symbol.search` - Search symbols by name
- `sdl.symbol.getCard` - Get symbol card with ETag support
- `sdl.slice.build` - Build graph slice with handle/lease
- `sdl.slice.refresh` - Refresh slice with delta-only updates
- `sdl.slice.spillover.get` - Retrieve overflow data
- `sdl.delta.get` - Get delta pack for changed symbols
- `sdl.code.needWindow` - Request code window with policy checks
- `sdl.code.getSkeleton` - Get code skeleton
- `sdl.policy.get` - Get current policy settings
- `sdl.policy.set` - Update policy settings
- `sdl.pr.risk.analyze` - Analyze PR risk with delta, blast radius, and test recommendations

## Client Integration

### Claude Code

```bash
# Initialize with Claude Code template
sdl-mcp init --client claude-code

# Copy the generated claude-code-mcp-config.json to your Claude Code config
# location (~/.config/claude-code/claude_desktop_config.json)
```

### Opencode

```bash
# Initialize with Opencode template
sdl-mcp init --client opencode

# Copy the generated opencode-mcp-config.json to your Opencode config location
```

### Other Clients

Supported client templates:

- `claude-code`
- `codex`
- `gemini`
- `opencode`

## Development

```bash
# Watch for changes
npm run watch

# Type checking
npm run typecheck

# Linting
npm run lint

# Format code
npm run format

# Run tests
npm test

# Run test harness
npm run test:harness
```

## Troubleshooting

### "Config file not found"

Run `sdl-mcp init` to create configuration file, or specify path with `--config`.

### "Tree-sitter grammar unavailable"

Ensure dependencies are installed: `npm install`

### "Repository path not accessible"

Check that `rootPath` in config points to an existing directory with read permissions.

### Indexing is slow

- Reduce `indexing.concurrency` in config
- Add more patterns to `ignore` list to exclude non-essential files
- Set `maxFileBytes` to skip large files

### Server won't start

Run `sdl-mcp doctor` to validate environment, then check logs with `--log-level debug`.

## Known Limitations

- **TypeScript diagnostics** - Only available for TS/JS files (uses TypeScript Language Server)
- **Language-specific features** - Some language-specific features may not be fully supported:
  - Python: Type hints are captured as annotations, not inferred
  - Go: Interface satisfaction is not detected
  - Java: Generic type erasure means generic type information is limited
  - C#: Async/await state machines are not fully tracked
  - C/C++: Preprocessor conditionals (#if/#ifdef) are not fully resolved
  - PHP: Trait method resolution order is not tracked
  - Rust: Lifetimes and borrow checker rules are not analyzed
  - Kotlin: Inline functions and property delegates use simplified models
  - Shell: Command substitution and heredocs are partially supported
- **Cross-language analysis** - Symbol relationships across language boundaries are not detected (e.g., Python calling Go via FFI)
- **Comment parsing** - JSDoc/Docstring comments are not extracted for all languages

## Documentation

- **[User Guide](docs/USER_GUIDE.md)** - Comprehensive documentation with MCP tool reference
- **[Testing Guide](docs/TESTING.md)** - Multi-language testing instructions
- **[Sync Artifact Documentation](docs/sync-artifacts.md)** - Sync artifact system details
- **[CI Memory Sync Operations Guide](docs/CI_MEMORY_SYNC.md)** - CI sync operations, troubleshooting, and recovery
- **[CI Memory Sync Setup Guide](docs/CI_MEMORY_SYNC_SETUP.md)** - Step-by-step CI memory sync setup
- **[Cross-Platform Validation](docs/CROSS_PLATFORM_VALIDATION.md)** - Linux/Windows CI validation
- `Symbol_Data_Ledger_MCP.md` - Product Requirements Document
- `SDL-MCP_v0.4.md` - v0.4 feature specifications
- `SDL-MCP_v0.5.md` - v0.5 feature specifications
- `CHANGELOG.md` - Version history
- `AGENTS.md` - Development coordination

## Performance

SDL-MCP provides significant token savings compared to traditional file-based context:

| Metric              | Traditional | SDL-MCP     | Improvement       |
| ------------------- | ----------- | ----------- | ----------------- |
| Token usage         | ~115,000    | ~1,400      | **78% reduction** |
| Compression ratio   | 1x          | 4.7x        | **4.7x better**   |
| Call edge detection | -           | 2,609 edges | Full graph        |

### Real-World Benchmark

Run the real-world use case benchmark to compare SDL-MCP slices against a
traditional "grep + open files" workflow:

```bash
npm run benchmark:real
```

Tasks are defined in `benchmarks/real-world/tasks.json`.

## License

MIT
