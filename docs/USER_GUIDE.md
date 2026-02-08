# SDL-MCP User Guide

**Symbol Delta Ledger MCP Server** - Cards-first code context for TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell repositories.

Version: 0.5.1 | License: MIT

---

## Table of Contents

1. [Introduction](#introduction)
2. [Supported Languages](#supported-languages)
3. [Installation](#installation)
4. [Quick Start](#quick-start)
5. [Multi-Language Setup](#multi-language-setup)
6. [Core Concepts](#core-concepts)
7. [CLI Reference](#cli-reference)
8. [MCP Tools Reference](#mcp-tools-reference)
9. [Configuration](#configuration)
10. [Client Integration](#client-integration)
11. [Best Practices](#best-practices)
12. [Troubleshooting](#troubleshooting)
13. [Architecture](#architecture)

---

## Introduction

SDL-MCP transforms how AI assistants interact with codebases. Instead of reading raw files (which consumes massive token budgets), SDL-MCP provides:

- **Symbol Cards**: Compact metadata about functions, classes, and types
- **Graph Slices**: Task-scoped subsets of your codebase's dependency graph
- **Delta Packs**: Efficient change tracking between versions
- **Policy-Governed Access**: Smart gating that provides the right context at the right time

### Why SDL-MCP?

| Traditional Approach         | SDL-MCP Approach                 |
| ---------------------------- | -------------------------------- |
| Read entire files            | Request symbol cards             |
| ~115,000 tokens for 73 files | ~1,400 tokens for same context   |
| No dependency awareness      | Full call/import graph           |
| Stale context                | Delta-based updates              |
| Language-specific tools      | Unified multi-language interface |

**Measured Results**: 78% token reduction with 4.7x compression ratio.

**Language Support**: Works with TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell codebases.

---

## Supported Languages

SDL-MCP supports indexing and analysis for multiple programming languages using tree-sitter parsers.

| Language   | Extensions                                   | Status | Key Features                                        |
| ---------- | -------------------------------------------- | ------ | --------------------------------------------------- |
| TypeScript | `.ts`, `.tsx`                                | Full   | Type inference, generics, decorators, JSX           |
| JavaScript | `.js`, `.jsx`                                | Full   | ES6+ features, JSX, CommonJS/ESM modules            |
| Python     | `.py`                                        | Full   | Functions, classes, methods, decorators, generators |
| Go         | `.go`                                        | Full   | Packages, functions with receivers, interfaces      |
| Java       | `.java`                                      | Full   | Classes, interfaces, enums, records, annotations    |
| C#         | `.cs`                                        | Full   | Namespaces, classes, properties, async/await        |
| C          | `.c`, `.h`                                   | Full   | Functions, structs, pointers, preprocessor          |
| C++        | `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx` | Full   | Classes, templates, namespaces, STL                 |
| PHP        | `.php`, `.phtml`                             | Full   | Classes, functions, namespaces, traits              |
| Rust       | `.rs`                                        | Full   | Structs, enums, traits, modules, lifetimes          |
| Kotlin     | `.kt`, `.kts`                                | Full   | Classes, functions, properties, coroutines          |
| Shell      | `.sh`, `.bash`                               | Full   | Functions, variables, command execution             |

### Symbol Kinds by Language

**TypeScript/JavaScript**: `function`, `class`, `interface`, `type`, `method`, `variable`, `module`

**Python**: `function`, `class`, `method`, `variable`, `decorator`, `generator`

**Go**: `function`, `method`, `type`, `variable`, `interface`, `package`

**Java**: `function`, `class`, `interface`, `enum`, `record`, `method`, `constructor`, `field`, `annotation`

**C#**: `function`, `class`, `interface`, `struct`, `enum`, `record`, `method`, `constructor`, `property`, `field`, `namespace`

**C**: `function`, `class` (struct), `variable`, `preproc_def`, `macro`

**C++**: `function`, `class`, `method`, `variable`, `template`, `namespace`

**PHP**: `function`, `class`, `interface`, `trait`, `method`, `property`, `namespace`

**Rust**: `function`, `struct`, `enum`, `trait`, `impl`, `module`, `variable`

**Kotlin**: `function`, `class`, `interface`, `object`, `property`, `variable`, `companion`

**Shell**: `function`, `variable`, `command`

### Language-Specific Features

#### TypeScript/JavaScript

- Type inference for signatures
- JSDoc comment extraction
- JSX/TSX component detection
- CommonJS and ESM module support

#### Python

- Decorator metadata capture
- Type hint preservation
- Async function detection
- Generator function support

#### Go

- Receiver type tracking for methods
- Package-scoped visibility (capitalization)
- Interface and struct definitions
- Goroutine (`go`) and defer detection

#### Java

- Access modifier tracking
- Annotation capture
- Generic type parameters
- Static vs instance detection

#### C#

- Async/await tracking
- Property accessors (get/set)
- Namespace resolution
- Attribute (decorator) capture

#### C

- Preprocessor directive tracking
- Struct and union definitions
- Function pointer detection
- Header file relationship tracking

#### C++

- Template parameter extraction
- Namespace hierarchy
- Class inheritance (single/multiple)
- STL container usage

#### PHP

- Trait method resolution
- Namespace and use statement tracking
- Anonymous class detection
- Class property visibility

#### Rust

- Lifetime parameter extraction
- Trait implementation tracking
- Module path resolution
- Macro invocation detection

#### Kotlin

- Property accessor (get/set) inference
- Coroutines and suspend functions
- Companion object tracking
- Extension function identification

#### Shell

- Function definition parsing
- Variable assignment detection
- Command alias identification
- Shebang and script entry point tracking

---

## Installation

### Requirements

- **Node.js**: >= 18.0.0
- **npm**: >= 8.0.0 (included with Node.js)
- **Operating System**: Windows, macOS, or Linux

### Install from npm

```bash
npm install -g sdl-mcp
```

### Install from Source

```bash
git clone https://github.com/your-org/sdl-mcp.git
cd sdl-mcp
npm install
npm run build
npm install -g .
```

### Verify Installation

```bash
sdl-mcp version
```

Expected output:

```
SDL-MCP version: 0.5.1

Environment:
  Node.js: v22.x.x
  Platform: win32
  Arch: x64
```

---

## Quick Start

### Step 1: Initialize Configuration

```bash
cd /path/to/your/project
sdl-mcp init --client claude-code
```

This creates:

- `config/sdlmcp.config.json` - Main configuration
- `claude-code-mcp-config.json` - Client integration template

### Step 2: Validate Environment

```bash
sdl-mcp doctor
```

Expected output:

```
SDL-MCP Doctor
==============

Checking environment...

[PASS] Node.js version: v22.21.1 (>= 18.0.0)
[PASS] Config file exists: ./config/sdlmcp.config.json
[PASS] Config file readable
[PASS] Database path writable
[PASS] Tree-sitter grammar available
[PASS] Repo paths accessible: 1 repo(s)

All checks passed!
```

### Step 3: Index Your Codebase

```bash
sdl-mcp index
```

Expected output:

```
Indexing 1 repo(s)...

Indexing my-repo (/path/to/project)...
  Files: 73
  Symbols: 1,924
  Edges: 13,086
  Duration: 8,234ms

Indexing complete!
```

### Step 4: Start the Server

```bash
sdl-mcp serve --stdio
```

The server is now ready to receive MCP tool calls from your AI assistant.

---

## Multi-Language Setup

### Single-Language Repository

For a repository with a single language, specify only that language:

```json
{
  "repos": [
    {
      "repoId": "python-service",
      "rootPath": "/path/to/project",
      "languages": ["py"]
    }
  ]
}
```

### Polyglot Repository

For a repository with multiple languages, include all languages you want to index:

```json
{
  "repos": [
    {
      "repoId": "microservices-platform",
      "rootPath": "/path/to/project",
      "languages": [
        "ts",
        "tsx",
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
      ]
    }
  ]
}
```

### Monorepo with Multiple Languages

For monorepos with services in different languages:

```json
{
  "repos": [
    {
      "repoId": "frontend-service",
      "rootPath": "/path/to/monorepo/services/frontend",
      "languages": ["ts", "tsx"]
    },
    {
      "repoId": "api-service",
      "rootPath": "/path/to/monorepo/services/api",
      "languages": ["py"]
    },
    {
      "repoId": "worker-service",
      "rootPath": "/path/to/monorepo/services/worker",
      "languages": ["go"]
    }
  ]
}
```

### Language Filtering

You can exclude certain languages by not listing them in the `languages` array:

```json
{
  "repos": [
    {
      "repoId": "mixed-project",
      "rootPath": "/path/to/project",
      "ignore": ["**/node_modules/**", "**/dist/**"],
      "languages": ["ts", "go", "java"]
    }
  ]
}
```

This configuration will index `.ts`, `.tsx`, `.js`, `.jsx`, `.go`, and `.java` files while ignoring Python (`.py`) and C# (`.cs`) files.

### Cross-Language Symbol Search

When working with polyglot codebases, SDL-MCP enables searching across all indexed languages:

```json
{
  "repoId": "microservices-platform",
  "query": "parseConfig",
  "kinds": ["function", "method"]
}
```

This will return all functions and methods named `parseConfig` across all indexed languages (TypeScript, Python, Go, Java, etc.).

### Working with Language-Boundaries

SDL-MCP does not track cross-language relationships (e.g., Python calling Go via FFI). When building slices for polyglot tasks:

1. Identify entry points in each language
2. Build separate slices for each language component
3. Combine results in your AI workflow

Example workflow for a bug in a polyglot system:

```javascript
// Search for TypeScript frontend component
const frontendResult = await sdl.symbol.search({
  repoId: "my-platform",
  query: "handleRequest",
  kinds: ["function"],
  limit: 10,
});

// Search for Python backend component
const backendResult = await sdl.symbol.search({
  repoId: "my-platform",
  query: "handleRequest",
  kinds: ["function"],
  limit: 10,
});

// Build separate slices
const frontendSlice = await sdl.slice.build({
  repoId: "my-platform",
  entrySymbols: [frontendResult.symbols[0].symbolId],
  maxCards: 50,
});

const backendSlice = await sdl.slice.build({
  repoId: "my-platform",
  entrySymbols: [backendResult.symbols[0].symbolId],
  maxCards: 50,
});
```

---

## Core Concepts

### Symbol Cards

A **Symbol Card** is a compact metadata record for a code symbol (function, class, interface, type, or variable).

**Structure:**

```json
{
  "symbolId": "abc123...",
  "repoId": "my-repo",
  "filePath": "src/utils/parser.ts",
  "kind": "function",
  "name": "parseConfig",
  "exported": true,
  "signature": {
    "params": [
      { "name": "input", "type": "string" },
      { "name": "options", "type": "ParseOptions" }
    ],
    "returnType": "Config",
    "async": false
  },
  "summary": "Parses configuration string into structured Config object",
  "invariants": ["input must be valid JSON", "returns null on parse failure"],
  "sideEffects": [],
  "deps": {
    "imports": ["Config", "ParseOptions"],
    "calls": ["JSON.parse", "validateConfig"]
  },
  "metrics": {
    "fanIn": 12,
    "fanOut": 3,
    "churn30d": 2,
    "testRefs": 5
  }
}
```

**Key Fields:**

- `symbolId`: Stable hash (survives whitespace changes)
- `signature`: Function/method signature details
- `summary`: 1-2 line description
- `invariants`: Behavioral contracts
- `sideEffects`: External interactions (network, fs, etc.)
- `deps`: Import and call edges
- `metrics`: Usage and change frequency

### Graph Slices

A **Graph Slice** is a task-scoped subset of your codebase's dependency graph.

**How it works:**

1. You provide seed symbols (entry points)
2. SDL-MCP traverses the dependency graph using weighted edges
3. Returns cards up to your token budget
4. Provides a handle for cache-coherent updates

**Edge Weights:**
| Edge Type | Default Weight | Description |
|-----------|----------------|-------------|
| `call` | 1.0 | Function calls another function |
| `config` | 0.8 | Configuration relationship |
| `import` | 0.6 | Module imports symbol |

**Example Slice Response:**

```json
{
  "sliceId": "slice_abc123",
  "handle": "h_xyz789",
  "leaseExpiresAt": "2024-01-15T12:30:00Z",
  "cards": [...],
  "totalCards": 42,
  "truncated": false,
  "tokenBudget": { "limit": 12000, "used": 8500 }
}
```

### Context Ladder

SDL-MCP implements a 4-rung **Context Ladder** that escalates from minimal to full context:

| Rung        | Tool                   | Token Cost  | When to Use                            |
| ----------- | ---------------------- | ----------- | -------------------------------------- |
| 1. Card     | `sdl.symbol.getCard`   | ~135 tokens | Understanding signatures, dependencies |
| 2. Skeleton | `sdl.code.getSkeleton` | ~113 tokens | Understanding control flow             |
| 3. Hot-path | `sdl.code.getHotPath`  | ~200 tokens | Finding specific identifiers           |
| 4. Raw      | `sdl.code.needWindow`  | Variable    | Full implementation details            |

**Best Practice**: Start at Rung 1 and only escalate when needed.

### Delta Packs

A **Delta Pack** captures changes between two ledger versions:

```json
{
  "fromVersion": "v1704067200000",
  "toVersion": "v1704153600000",
  "changedSymbols": [
    {
      "symbolId": "abc123",
      "changeType": "modified",
      "signatureChanged": true,
      "summaryChanged": false
    }
  ],
  "blastRadius": [{ "symbolId": "def456", "proximity": 1, "fanIn": 8 }]
}
```

**Blast Radius**: Shows which symbols might be affected by changes (callers, importers).

---

## CLI Reference

### Global Options

All commands support these options:

| Option                  | Default                       | Description                      |
| ----------------------- | ----------------------------- | -------------------------------- |
| `-c, --config <PATH>`   | `./config/sdlmcp.config.json` | Configuration file path          |
| `--log-level <LEVEL>`   | `info`                        | `debug`, `info`, `warn`, `error` |
| `--log-format <FORMAT>` | `pretty`                      | `json` or `pretty`               |
| `-h, --help`            | -                             | Show help                        |
| `-v, --version`         | -                             | Show version                     |

### `sdl-mcp init`

Initialize SDL-MCP configuration.

```bash
sdl-mcp init [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--client <NAME>` | Generate client config: `claude-code`, `codex`, `gemini`, `opencode` |
| `--repo-path <PATH>` | Repository root (default: current directory) |
| `--languages <LANGS>` | Languages to index: `ts,tsx,js,jsx,py,go,java,cs,c,cpp,php,rs,kt,sh` (default: all) |

**Examples:**

```bash
# Basic initialization (all languages)
sdl-mcp init

# Initialize with specific languages
sdl-mcp init --languages ts,tsx,js,jsx,py

# Initialize with Claude Code integration
sdl-mcp init --client claude-code

# Initialize for a different directory with specific languages
sdl-mcp init --repo-path /path/to/project --client codex --languages go,java,cs,c,cpp,php
```

### `sdl-mcp doctor`

Validate environment and configuration.

```bash
sdl-mcp doctor [options]
```

**Checks performed:**

1. Node.js version >= 18.0.0
2. Configuration file exists and is readable
3. Database path is writable
4. Tree-sitter TypeScript grammar loads
5. All repository paths are accessible

### `sdl-mcp index`

Index repositories into the symbol database.

```bash
sdl-mcp index [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-w, --watch` | Watch for changes and re-index automatically |
| `--repo-id <ID>` | Index specific repository (default: all) |

**Examples:**

```bash
# Index all repositories
sdl-mcp index

# Index specific repository
sdl-mcp index --repo-id my-backend

# Watch mode for development
sdl-mcp index --watch
```

### `sdl-mcp serve`

Start the MCP server.

```bash
sdl-mcp serve [options]
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `--stdio` | Yes | Use stdio transport (for MCP clients) |
| `--http` | No | Use HTTP transport (for testing) |
| `--port <NUMBER>` | 3000 | HTTP port |
| `--host <HOST>` | localhost | HTTP host |

**Examples:**

```bash
# Standard usage with Claude Code
sdl-mcp serve --stdio

# HTTP mode for testing
sdl-mcp serve --http --port 8080

# Debug mode
sdl-mcp serve --stdio --log-level debug
```

### `sdl-mcp version`

Display version and environment information.

```bash
sdl-mcp version
```

---

## MCP Tools Reference

SDL-MCP exposes 14 MCP tools organized into 6 categories.

### Repository Management

#### `sdl.repo.register`

Register a new repository for indexing.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Unique repository identifier |
| `rootPath` | string | Yes | Absolute path to repository root |
| `ignore` | string[] | No | Glob patterns to exclude |
| `languages` | string[] | No | File extensions to index |
| `maxFileBytes` | number | No | Maximum file size (default: 2MB) |

**Example Request:**

```json
{
  "repoId": "my-api",
  "rootPath": "/Users/dev/projects/my-api",
  "ignore": ["**/node_modules/**", "**/dist/**"],
  "languages": ["ts", "tsx"]
}
```

**Example Response:**

```json
{
  "ok": true,
  "repoId": "my-api"
}
```

---

#### `sdl.repo.status`

Get repository indexing status.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |

**Example Response:**

```json
{
  "repoId": "my-api",
  "rootPath": "/Users/dev/projects/my-api",
  "latestVersionId": "v1704153600000",
  "filesIndexed": 73,
  "symbolsIndexed": 1924,
  "lastIndexedAt": "2024-01-15T10:30:00Z"
}
```

---

#### `sdl.index.refresh`

Trigger repository re-indexing.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `mode` | string | No | `full` or `incremental` (default: `incremental`) |

**Example Response:**

```json
{
  "ok": true,
  "repoId": "my-api",
  "versionId": "v1704153700000",
  "changedFiles": 5
}
```

---

### Symbol Operations

#### `sdl.symbol.search`

Search for symbols by name or summary.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `query` | string | Yes | Search query (name or summary text) |
| `kinds` | string[] | No | Filter by kind: `function`, `class`, `interface`, `type`, `method`, `variable` |
| `limit` | number | No | Maximum results (default: 50, max: 1000) |

**Example Request:**

```json
{
  "repoId": "my-api",
  "query": "parse",
  "kinds": ["function", "method"],
  "limit": 20
}
```

**Example Response:**

```json
{
  "symbols": [
    {
      "symbolId": "abc123",
      "name": "parseConfig",
      "kind": "function",
      "filePath": "src/config/parser.ts",
      "exported": true,
      "summary": "Parses configuration from JSON string"
    },
    {
      "symbolId": "def456",
      "name": "parseArgs",
      "kind": "function",
      "filePath": "src/cli/args.ts",
      "exported": true,
      "summary": "Parses command line arguments"
    }
  ],
  "totalCount": 2,
  "truncated": false
}
```

---

#### `sdl.symbol.getCard`

Get full symbol card with caching support.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol identifier |
| `ifNoneMatch` | string | No | ETag for conditional fetch |

**Example Request:**

```json
{
  "repoId": "my-api",
  "symbolId": "abc123"
}
```

**Example Response:**

```json
{
  "card": {
    "symbolId": "abc123",
    "repoId": "my-api",
    "filePath": "src/config/parser.ts",
    "kind": "function",
    "name": "parseConfig",
    "exported": true,
    "signature": {
      "params": [{ "name": "input", "type": "string" }],
      "returnType": "Config",
      "async": false
    },
    "summary": "Parses configuration from JSON string",
    "invariants": ["input must be valid JSON"],
    "sideEffects": [],
    "deps": {
      "imports": ["Config"],
      "calls": ["JSON.parse", "validateConfig"]
    },
    "metrics": {
      "fanIn": 12,
      "fanOut": 2,
      "churn30d": 1,
      "testRefs": 3
    }
  },
  "etag": "W/\"abc123-v1704153600000\"",
  "notModified": false
}
```

**Conditional Fetch (304 Not Modified):**

```json
{
  "repoId": "my-api",
  "symbolId": "abc123",
  "ifNoneMatch": "W/\"abc123-v1704153600000\""
}
```

Response when unchanged:

```json
{
  "card": null,
  "etag": "W/\"abc123-v1704153600000\"",
  "notModified": true
}
```

---

### Graph Slicing

#### `sdl.slice.build`

Build a task-scoped graph slice from seed symbols.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `entrySymbols` | string[] | Yes | Seed symbol IDs |
| `maxCards` | number | No | Maximum cards (default: 300) |
| `maxTokens` | number | No | Token budget (default: 12000) |
| `includeTests` | boolean | No | Include test files (default: false) |

**Example Request:**

```json
{
  "repoId": "my-api",
  "entrySymbols": ["abc123", "def456"],
  "maxCards": 50,
  "maxTokens": 8000
}
```

**Example Response:**

```json
{
  "sliceId": "slice_xyz789",
  "handle": "h_abc123",
  "leaseExpiresAt": "2024-01-15T11:00:00Z",
  "cards": [
    { "symbolId": "abc123", "name": "parseConfig", ... },
    { "symbolId": "def456", "name": "validateConfig", ... },
    { "symbolId": "ghi789", "name": "Config", ... }
  ],
  "totalCards": 3,
  "truncated": false,
  "tokenBudget": {
    "limit": 8000,
    "used": 2400
  },
  "spilloverHandle": null
}
```

---

#### `sdl.slice.refresh`

Refresh an existing slice with delta updates only.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `handle` | string | Yes | Slice handle from `slice.build` |
| `sinceVersion` | string | No | Version to compare against |

**Example Response:**

```json
{
  "handle": "h_abc123",
  "leaseExpiresAt": "2024-01-15T11:30:00Z",
  "addedCards": [],
  "removedSymbolIds": [],
  "modifiedCards": [
    { "symbolId": "abc123", "name": "parseConfig", ... }
  ]
}
```

---

#### `sdl.slice.spillover.get`

Retrieve overflow symbols that didn't fit in the initial slice.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `spilloverHandle` | string | Yes | Handle from `slice.build` |
| `offset` | number | No | Starting offset (default: 0) |
| `limit` | number | No | Maximum cards (default: 50) |

---

### Delta Tracking

#### `sdl.delta.get`

Get changes between two ledger versions.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `fromVersion` | string | No | Starting version (default: previous) |
| `toVersion` | string | No | Ending version (default: latest) |
| `includeBlastRadius` | boolean | No | Include affected symbols (default: true) |

**Example Response:**

```json
{
  "fromVersion": "v1704067200000",
  "toVersion": "v1704153600000",
  "changedSymbols": [
    {
      "symbolId": "abc123",
      "changeType": "modified",
      "signatureChanged": true,
      "summaryChanged": false
    },
    {
      "symbolId": "xyz789",
      "changeType": "added",
      "signatureChanged": false,
      "summaryChanged": false
    }
  ],
  "blastRadius": [
    {
      "symbolId": "caller1",
      "proximity": 1,
      "fanIn": 5,
      "reason": "calls abc123"
    }
  ],
  "diagnostics": {
    "newErrors": 0,
    "resolvedErrors": 1
  }
}
```

---

### Code Access

#### `sdl.code.needWindow`

Request raw code with policy-governed access.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol to retrieve code for |
| `reason` | string | Yes | Justification for code access |
| `expectedIdentifiers` | string[] | No | Identifiers expected in the code |
| `contextLines` | number | No | Lines of context around symbol |
| `breakGlass` | boolean | No | Override policy denial (audited) |

**Example Request:**

```json
{
  "repoId": "my-api",
  "symbolId": "abc123",
  "reason": "Need to understand validation logic",
  "expectedIdentifiers": ["validateSchema", "throwError"],
  "contextLines": 5
}
```

**Example Response (Approved):**

```json
{
  "approved": true,
  "code": "export function parseConfig(input: string): Config {\n  const parsed = JSON.parse(input);\n  validateSchema(parsed);\n  return parsed as Config;\n}",
  "range": {
    "startLine": 15,
    "endLine": 20,
    "startCol": 0,
    "endCol": 1
  },
  "truncated": false,
  "redacted": false
}
```

**Example Response (Denied with Guidance):**

```json
{
  "approved": false,
  "denialReason": "Identifiers not found in symbol range",
  "nextBestAction": {
    "tool": "sdl.code.getSkeleton",
    "params": { "repoId": "my-api", "symbolId": "abc123" }
  }
}
```

---

#### `sdl.code.getSkeleton`

Get deterministic code skeleton (signatures + control flow, elided bodies).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol identifier |
| `includeIdentifiers` | string[] | No | Identifiers to preserve in skeleton |

**Example Response:**

```json
{
  "skeleton": "export function parseConfig(input: string): Config {\n  // ...\n  if (validationResult.errors) {\n    // ...\n  }\n  return parsed;\n}",
  "ir": {
    "symbolId": "abc123",
    "ops": [
      { "op": "if", "line": 3 },
      { "op": "elision", "reason": "block", "startLine": 4, "endLine": 6 },
      { "op": "return", "line": 8 }
    ],
    "hash": "sha256:...",
    "totalLines": 12,
    "elidedLines": 6
  },
  "estimatedTokens": 85
}
```

---

#### `sdl.code.getHotPath`

Extract lines matching specific identifiers.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol identifier |
| `identifiers` | string[] | Yes | Identifiers to find |
| `contextLines` | number | No | Lines around each match (default: 2) |

**Example Response:**

```json
{
  "excerpts": [
    {
      "identifier": "validateSchema",
      "line": 17,
      "code": "  validateSchema(parsed);",
      "context": {
        "before": ["  const parsed = JSON.parse(input);"],
        "after": ["  return parsed as Config;"]
      }
    }
  ],
  "estimatedTokens": 45
}
```

---

### Policy Management

#### `sdl.policy.get`

Get current policy settings.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |

**Example Response:**

```json
{
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

---

#### `sdl.policy.set`

Update policy settings.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repoId` | string | Yes | Repository identifier |
| `policy` | object | Yes | Policy fields to update (partial) |

**Example Request:**

```json
{
  "repoId": "my-api",
  "policy": {
    "maxWindowLines": 250,
    "allowBreakGlass": false
  }
}
```

---

## Configuration

### Configuration File

Default location: `./config/sdlmcp.config.json`

### Complete Configuration Reference

```json
{
  "repos": [
    {
      "repoId": "my-project",
      "rootPath": "/absolute/path/to/project",
      "ignore": [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/vendor/**"
      ],
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
      "maxFileBytes": 2000000,
      "packageJsonPath": "package.json",
      "tsconfigPath": "tsconfig.json",
      "workspaceGlobs": ["packages/*"]
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
    "patterns": [
      {
        "name": "custom-api-key",
        "pattern": "CUSTOM_[A-Z0-9]{32}",
        "replacement": "[REDACTED:custom-api-key]"
      }
    ]
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

### Configuration Sections Explained

#### `repos` - Repository Definitions

| Field             | Type     | Default       | Description                                                                                         |
| ----------------- | -------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `repoId`          | string   | Required      | Unique identifier                                                                                   |
| `rootPath`        | string   | Required      | Absolute path to repository                                                                         |
| `ignore`          | string[] | See below     | Glob patterns to exclude                                                                            |
| `languages`       | string[] | All supported | Extensions: `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh` |
| `maxFileBytes`    | number   | 2000000       | Skip files larger than this                                                                         |
| `packageJsonPath` | string   | Auto-detected | Path to package.json                                                                                |
| `tsconfigPath`    | string   | Auto-detected | Path to tsconfig.json                                                                               |
| `workspaceGlobs`  | string[] | Auto-detected | Monorepo workspace patterns                                                                         |

**Default ignore patterns:**

```json
[
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/vendor/**",
  "**/target/**"
]
```

#### `policy` - Context Governance

| Field                | Type    | Default | Description                     |
| -------------------- | ------- | ------- | ------------------------------- |
| `maxWindowLines`     | number  | 180     | Maximum lines per code window   |
| `maxWindowTokens`    | number  | 1400    | Maximum tokens per window       |
| `requireIdentifiers` | boolean | true    | Require expected identifiers    |
| `allowBreakGlass`    | boolean | true    | Allow policy override (audited) |

#### `redaction` - Sensitive Data Protection

| Field             | Type    | Default | Description           |
| ----------------- | ------- | ------- | --------------------- |
| `enabled`         | boolean | true    | Enable redaction      |
| `includeDefaults` | boolean | true    | Use built-in patterns |
| `patterns`        | array   | []      | Custom patterns       |

**Default redaction patterns:**

- API keys (AWS, Google, Stripe, etc.)
- Email addresses
- Private keys
- Database connection strings
- JWT tokens

#### `indexing` - Indexing Behavior

| Field                | Type    | Default | Description                         |
| -------------------- | ------- | ------- | ----------------------------------- |
| `concurrency`        | number  | 4       | Parallel indexing workers (max: 10) |
| `enableFileWatching` | boolean | false   | Auto-reindex on file changes        |

#### `slice` - Graph Slice Settings

| Field                | Type   | Default | Description               |
| -------------------- | ------ | ------- | ------------------------- |
| `defaultMaxCards`    | number | 300     | Default symbols per slice |
| `defaultMaxTokens`   | number | 12000   | Default token budget      |
| `edgeWeights.call`   | number | 1.0     | Weight for call edges     |
| `edgeWeights.import` | number | 0.6     | Weight for import edges   |
| `edgeWeights.config` | number | 0.8     | Weight for config edges   |

#### `diagnostics` - TypeScript Integration

| Field       | Type    | Default        | Description                     |
| ----------- | ------- | -------------- | ------------------------------- |
| `enabled`   | boolean | true           | Enable diagnostics (TS/JS only) |
| `mode`      | string  | "tsLS"         | `tsLS` or `tsc`                 |
| `maxErrors` | number  | 50             | Maximum errors to include       |
| `timeoutMs` | number  | 2000           | Diagnostics timeout             |
| `scope`     | string  | "changedFiles" | `changedFiles` or `workspace`   |

**Note**: Diagnostics are only available for TypeScript/JavaScript files. Other languages are indexed without type checking.

### Environment Variables

| Variable         | Description               |
| ---------------- | ------------------------- |
| `SDL_CONFIG`     | Override config file path |
| `SDL_LOG_LEVEL`  | Override log level        |
| `SDL_LOG_FORMAT` | Override log format       |

---

## Client Integration

### Claude Code

1. Initialize with client template:

   ```bash
   sdl-mcp init --client claude-code
   ```

2. Copy generated config to Claude Code:

   ```bash
   # macOS/Linux
   cp claude-code-mcp-config.json ~/.config/claude-code/mcp.json

   # Windows
   copy claude-code-mcp-config.json %APPDATA%\claude-code\mcp.json
   ```

3. **Configure the agent to use SDL-MCP** by creating a `CLAUDE.md` file in your project root:

   ```bash
   # Copy the template
   cp node_modules/sdl-mcp/templates/CLAUDE.md.template ./CLAUDE.md

   # Edit to set your repository ID
   # Replace {{REPO_ID}} with your actual repo ID (e.g., "my-project")
   ```

4. Restart Claude Code

**Template structure:**

```json
{
  "mcpServers": {
    "sdl-mcp": {
      "command": "npx",
      "args": ["sdl-mcp", "serve", "--stdio"],
      "env": {
        "SDL_CONFIG": "/path/to/your/project/config/sdlmcp.config.json"
      }
    }
  }
}
```

### Codex CLI

```bash
sdl-mcp init --client codex
```

### Gemini CLI

```bash
sdl-mcp init --client gemini
```

### OpenCode

```bash
sdl-mcp init --client opencode
```

---

## Configuring Agents to Use SDL-MCP

To ensure AI agents always prefer SDL-MCP tools over reading raw files, create a `CLAUDE.md` file in your project root.

### Using the Template

1. Copy the template from SDL-MCP:

   ```bash
   cp node_modules/sdl-mcp/templates/CLAUDE.md.template ./CLAUDE.md
   ```

2. Replace `{{REPO_ID}}` with your repository ID:

   ```bash
   # On macOS/Linux
   sed -i 's/{{REPO_ID}}/my-project/g' CLAUDE.md

   # On Windows (PowerShell)
   (Get-Content CLAUDE.md) -replace '\{\{REPO_ID\}\}', 'my-project' | Set-Content CLAUDE.md
   ```

### What the Template Includes

The `CLAUDE.md` template instructs agents to:

1. **Follow the Context Ladder**: Search → Card → Slice → Skeleton → Raw
2. **Always search first**: Use `sdl.symbol.search` before reading files
3. **Get cards before code**: Understand symbols via metadata first
4. **Justify raw code requests**: Provide reasons for `sdl.code.needWindow`
5. **Follow policy guidance**: Use `nextBestAction` when requests are denied

### Example CLAUDE.md

```markdown
# CLAUDE.md - SDL-MCP Integration

## Code Context Protocol

**IMPORTANT**: This project uses SDL-MCP. Always prefer SDL-MCP tools over reading raw files.

### Repository ID: `my-project`

### Context Ladder (Use in Order)

1. `sdl.symbol.search` - Find symbols by name
2. `sdl.symbol.getCard` - Understand signatures and dependencies
3. `sdl.slice.build` - Get related symbols for context
4. `sdl.code.getSkeleton` - See control flow structure
5. `sdl.code.needWindow` - Full code (last resort, requires justification)

### Do NOT

- Read entire files when SDL-MCP can provide context
- Skip cards and go directly to raw code
- Ignore the `nextBestAction` in denied responses
```

### Verifying Agent Behavior

After setting up `CLAUDE.md`, you can verify the agent uses SDL-MCP by:

1. Asking the agent to find a function - it should use `sdl.symbol.search`
2. Asking about what a function does - it should use `sdl.symbol.getCard`
3. Asking for implementation details - it should try skeleton before raw code

---

## Best Practices

### 1. Start with Cards, Escalate as Needed

```
Card (135 tokens) -> Skeleton (113 tokens) -> Hot-path (variable) -> Raw (variable)
```

Only request raw code when cards and skeletons don't provide enough information.

### 2. Use Meaningful Seed Symbols

When building slices, choose entry points that represent the task:

- For bug fixes: Start with the function containing the bug
- For features: Start with the main entry point
- For refactoring: Start with the symbol being refactored

### 3. Configure Appropriate Ignore Patterns

Exclude non-essential files to speed up indexing:

```json
{
  "ignore": [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/vendor/**",
    "**/target/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__mocks__/**"
  ]
}
```

### 4. Use Incremental Indexing in Development

```bash
sdl-mcp index --watch
```

Or enable in config:

```json
{
  "indexing": {
    "enableFileWatching": true
  }
}
```

### 5. Leverage ETag Caching

Always pass `ifNoneMatch` when fetching cards you've seen before:

```json
{
  "repoId": "my-api",
  "symbolId": "abc123",
  "ifNoneMatch": "W/\"abc123-v1704153600000\""
}
```

### 6. Use Slice Handles for Updates

Instead of rebuilding slices, use refresh:

```json
{
  "handle": "h_abc123"
}
```

---

## Troubleshooting

### "Config file not found"

**Cause**: No configuration file at expected path.

**Solution**:

```bash
sdl-mcp init
```

Or specify path:

```bash
sdl-mcp serve --stdio -c /path/to/config.json
```

### "Tree-sitter grammar unavailable"

**Cause**: Native dependencies not compiled.

**Solution**:

```bash
npm rebuild
# or
npm install --build-from-source
```

### "Repository path not accessible"

**Cause**: `rootPath` doesn't exist or lacks permissions.

**Solution**:

1. Verify path exists: `ls /path/to/repo`
2. Use absolute paths in config
3. Check file permissions

### "Indexing is slow"

**Causes**: Too many files, high concurrency on slow disk.

**Solutions**:

1. Add more ignore patterns
2. Reduce concurrency:
   ```json
   { "indexing": { "concurrency": 2 } }
   ```
3. Set `maxFileBytes` to skip large files

### "Server won't start"

**Solution**:

```bash
sdl-mcp doctor --log-level debug
```

Check for:

- Port conflicts (HTTP mode)
- Config parse errors
- Database lock issues

### "Symbols not found after changes"

**Cause**: Index is stale.

**Solution**:

```bash
sdl-mcp index
# or trigger via MCP:
sdl.index.refresh({ repoId: "my-api", mode: "incremental" })
```

### "ETag mismatch errors"

**Cause**: Cached ETag is from different version.

**Solution**: Fetch without `ifNoneMatch` to get fresh data, then cache new ETag.

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      MCP Client                              │
│                (Claude Code, Codex, etc.)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ MCP Protocol (stdio/HTTP)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      SDL-MCP Server                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │  Repo   │  │ Symbol  │  │  Slice  │  │  Code   │        │
│  │  Tools  │  │  Tools  │  │  Tools  │  │  Tools  │        │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘        │
│       │            │            │            │              │
│       ▼            ▼            ▼            ▼              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                    Policy Engine                      │  │
│  └──────────────────────────────────────────────────────┘  │
│       │            │            │            │              │
│       ▼            ▼            ▼            ▼              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Indexer  │  │  Graph   │  │  Delta   │  │ Skeleton │   │
│  │          │  │  Builder │  │  Engine  │  │ Generator│   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │            │            │            │              │
│       └────────────┴────────────┴────────────┘              │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              SQLite Database (WAL mode)               │  │
│  │  repos | files | symbols | edges | versions | audit   │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Indexing**: File → Tree-sitter AST → Symbols + Edges → SQLite
2. **Card Retrieval**: Symbol ID → Database Query → Card Assembly → Response
3. **Slice Building**: Seeds → BFS with Weights → Budget Pruning → Handle + Cards
4. **Code Access**: Request → Policy Check → Skeleton/Hot-path/Raw → Redaction → Response

### Database Schema

| Table             | Purpose                            |
| ----------------- | ---------------------------------- |
| `repos`           | Repository configurations          |
| `files`           | Indexed file metadata              |
| `symbols`         | Symbol cards                       |
| `edges`           | Dependency relationships           |
| `versions`        | Ledger version history             |
| `symbol_versions` | Symbol snapshots per version       |
| `metrics`         | Computed metrics (fan-in, fan-out) |
| `audit`           | Policy decision audit log          |

---

## Appendix: Symbol Kinds

| Kind          | Description                    | Example                   | Languages                      |
| ------------- | ------------------------------ | ------------------------- | ------------------------------ |
| `function`    | Standalone function/procedure  | `function parse() {}`     | All                            |
| `class`       | Class declaration              | `class Parser {}`         | TS/JS, Java, C#, Python        |
| `interface`   | Interface declaration          | `interface Config {}`     | TS/JS, Java, Go                |
| `type`        | Type alias                     | `type Result = ...`       | TS/JS                          |
| `method`      | Class/object method            | `class X { method() {} }` | All (Go: method with receiver) |
| `variable`    | Variable/const/let declaration | `const parser = ...`      | All                            |
| `module`      | Module/namespace/package       | `namespace Utils {}`      | TS/JS, Python, C#              |
| `constructor` | Constructor/initializer        | `constructor() {}`        | Java, C#                       |
| `property`    | Property/field with accessors  | `get name() {}`           | C#                             |
| `struct`      | Struct declaration             | `type User struct {}`     | Go, C#                         |
| `enum`        | Enum declaration               | `enum Color {}`           | Java, C#                       |
| `record`      | Record/data class declaration  | `record User {}`          | Java, C#                       |
| `decorator`   | Decorator/annotation metadata  | `@decorator`              | Python, Java, C#               |

---

## Appendix: Edge Types

| Type     | Weight | Description                     |
| -------- | ------ | ------------------------------- |
| `call`   | 1.0    | Function calls another function |
| `import` | 0.6    | Module imports symbol           |
| `config` | 0.8    | Configuration relationship      |

---

## Getting Help

- **Issues**: https://github.com/your-org/sdl-mcp/issues
- **Testing Guide**: See [TESTING.md](TESTING.md) for multi-language testing instructions
- **Documentation**: See `Symbol_Data_Ledger_MCP.md` for PRD
- **Changelog**: See `CHANGELOG.md` for version history
