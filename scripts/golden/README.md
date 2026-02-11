# Golden File Infrastructure

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Testing Guide](../../docs/TESTING.md)
  - [Troubleshooting](../../docs/troubleshooting.md)
- [Golden Scripts (this page)](./README.md)

</details>
</div>

This directory contains tools for managing golden files (expected output files) used in regression testing.

## Overview

Golden files store expected outputs to detect regressions in code extraction. SDL-MCP uses two types of golden files:

1. **E2E Golden Files** (`tests/golden/`): MCP tool response expectations
2. **Language Adapter Golden Files** (`tests/fixtures/{language}/`): Extraction expectations for each language

## Scripts

### `update-goldens.ts`

Manages language adapter golden files for all supported languages.

#### Usage

```bash
# Validate all golden files
npm run test:golden

# Regenerate all golden files
npm run golden:update

# Generate golden files for specific language
npm run golden:update rust

# Validate specific language
npm run test:golden rust
```

#### Supported Languages

- c (C)
- cpp (C++)
- php
- rust
- kotlin
- shell (Bash)
- java
- python
- csharp
- go

#### Golden File Patterns

**C/C++** (multiple file extensions):

```
expected-symbols.c.json
expected-symbols.h.json (C)
expected-symbols.cpp.json
expected-symbols.hpp.json (C++)
expected-imports.c/json
expected-imports.cpp/json
expected-calls.c/json
expected-calls.cpp/json
```

**Other Languages** (single JSON per type):

```
expected-symbols.json
expected-imports.json
expected-calls.json
```

## When to Regenerate Golden Files

**Regenerate golden files when:**

- Implementing a new adapter
- Making intentional changes to extraction logic
- Adding support for new language constructs
- Refactoring adapter internals that changes output format

**DO NOT regenerate when:**

- Fixing bugs (golden files should catch the bug)
- Making formatting-only changes (golden files should be stable)

## Golden File Validation

Golden files are validated by comparing current extraction results against stored expectations:

```typescript
// In integration tests
const symbols = adapter.extractSymbols(tree, code, filePath);
const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
assert.deepStrictEqual(
  symbols,
  golden,
  "Extracted symbols should match golden file",
);
```

## Directory Structure

```text
scripts/golden/
|-- e2e.ts              # E2E golden file manager
|-- update-goldens.ts   # Adapter golden file manager
`-- README.md           # This file

tests/
|-- golden/             # E2E golden files
|   |-- 01-register-repo.json
|   |-- 02-index-repo.json
|   `-- ...
`-- fixtures/           # Adapter golden files
    |-- rust/
    |   |-- expected-symbols.json
    |   |-- expected-imports.json
    |   `-- expected-calls.json
    |-- c/
    |-- cpp/
    `-- ...
```

## Troubleshooting

### Golden file mismatch

If golden file validation fails:

1. Check if the change is intentional
2. Review the diff to understand what changed
3. If intentional: `npm run golden:update {language}`
4. If unintentional: Debug the adapter to fix the regression

### Missing golden files

If you see "Missing golden file" error:

```bash
npm run golden:update {language}
```

### Adapter not found

If you see "Adapter not available" message:

1. Ensure the adapter exists in `src/indexer/adapter/`
2. Run `npm run build` to compile adapters
3. Check that the adapter is imported in `update-goldens.ts`

## Adding a New Language Adapter

1. Create adapter in `src/indexer/adapter/{language}.ts`
2. Add import in `scripts/golden/update-goldens.ts`
3. Create test fixtures in `tests/fixtures/{language}/`
4. Run `npm run golden:update {language}` to generate initial golden files
5. Verify golden files by running `npm run test:golden {language}`

## See Also

- [docs/TESTING.md](../../docs/TESTING.md) - Testing guide
- [AGENTS.md](../../AGENTS.md) - Development coordination

