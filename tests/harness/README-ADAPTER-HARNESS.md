# Adapter Test Harness

## Overview

The adapter test harness provides per-language fixture testing for SDL-MCP language adapters. It discovers fixture files for each supported language and runs extraction tests for symbols, imports, and calls.

## Usage

### Run all adapter tests

```bash
npm run test:adapters
```

### Run tests for a specific language

```bash
npm run test:adapters <language>
```

Examples:

```bash
npm run test:adapters rust
npm run test:adapters c
npm run test:adapters php
```

## Supported Languages

The harness automatically discovers fixtures for:

- TypeScript/JavaScript (.ts, .tsx, .js, .jsx)
- Java (.java)
- Go (.go)
- Python (.py)
- C# (.cs)
- C (.c, .h)
- C++ (.cpp, .cc, .cxx, .hpp, .hh, .hxx)
- PHP (.php, .phtml)
- Rust (.rs)
- Kotlin (.kt, .kts)
- Shell (.sh, .bash)

## Fixture Structure

For each language, the harness looks for fixture files in `tests/fixtures/<language>/`:

- `symbols.<ext>` - For testing symbol extraction
- `imports.<ext>` - For testing import extraction
- `calls.<ext>` - For testing call extraction

Optional expected output files can be provided:

- `expected-symbols.<ext>.json`
- `expected-imports.<ext>.json`
- `expected-calls.<ext>.json`

When expected files are present, the harness validates counts match. When absent, the test still passes and reports the extracted count.

## Test Categories

For each fixture file, the harness runs three test categories:

1. **Symbol Extraction**: Tests that the adapter can parse and extract symbols
2. **Import Extraction**: Tests that the adapter can extract import statements
3. **Call Extraction**: Tests that the adapter can extract function/method calls

## Output

The harness provides:

- Per-language test results
- Individual test pass/fail status
- Duration metrics for each language
- Summary of total passed/failed tests

Example output:

```
Testing Language: rust
==================================================
⚠️  Symbol extraction: tests/fixtures/rust/symbols.rs (no expected file)
⚠️  Import extraction: tests/fixtures/rust/imports.rs (no expected file)
⚠️  Call extraction: tests/fixtures/rust/calls.rs (no expected file)

--- Summary for rust ---
Passed: 3
Failed: 0
Duration: 17ms
```

## Implementation Notes

- Uses `pathToFileURL()` for cross-platform (Windows) compatibility when loading adapters
- Adapters are loaded dynamically from `dist/indexer/adapter/`
- Fixtures are located in `tests/fixtures/`
- Tests are isolated per language - failures in one language don't affect others

## Adding New Languages

To add a new language to the harness:

1. Add the language entry to the `loadLanguageConfig()` method in `adapter-runner.ts`
2. Create fixture files in `tests/fixtures/<language>/`
3. Optionally create expected JSON files
4. Ensure the adapter is built to `dist/indexer/adapter/<language>.js`
