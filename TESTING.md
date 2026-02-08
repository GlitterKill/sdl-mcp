# Testing Guide

## Test Execution Strategy

SDL-MCP uses a **dist-first testing strategy**: all tests run against built artifacts in the `dist/` directory, matching the shipped code.

### Why Dist-First?

- **Production fidelity**: Tests validate the exact code that users run
- **ESM compatibility**: Ensures `.js` extensions work correctly at runtime
- **CI alignment**: CI builds all artifacts before running tests
- **Type safety**: TypeScript compilation catches errors before tests execute

### Test Categories

#### 1. Unit Tests (`tests/*.test.ts`)

Run via `npm test` using Node.js built-in test runner (`node --test`).

**Import pattern:**

```typescript
// tests/skeleton.test.ts
import { parseFile } from "../dist/code/skeleton.js";
```

Tests import from `../dist/` with `.js` extensions.

#### 2. Integration Tests (`tests/harness/runner.ts`)

Run via `npm run test:harness`.

**Command:**

```bash
npm run build:scripts && node dist/tests/harness/runner.js
```

**Import pattern:**

```typescript
// tests/harness/runner.ts
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/main.js"],
  env,
});
```

Harness tests spawn the built server from `dist/main.js`.

## Running Tests

### Run All Tests

```bash
# Build first (required)
npm run build:all

# Run unit tests
npm test

# Run integration harness
npm run test:harness
```

### Run Specific Tests

```bash
# Run a single test file
node --test tests/skeleton.test.ts

# Run tests matching a pattern
node --test tests/*.test.ts
```

### CI Workflow

CI automatically runs:

1. `npm run build:all` (builds main code and scripts)
2. `npm test` (unit tests)
3. `npm run lint` (code quality)
4. `npm run typecheck` (type safety)

See `.github/workflows/ci.yml` for details.

## Writing Tests

### File Structure

```
tests/
├── *.test.ts          # Unit tests (built as .js)
├── harness/
│   ├── runner.ts      # Integration test runner
│   └── client-assertions.ts  # Client validation
└── golden/            # Golden fixture JSON files
```

### Import Rules

**DO:**

```typescript
// Import from dist/ with .js extension
import { foo } from "../dist/code/skeleton.js";
import { bar } from "../dist/mcp/tools/symbol.js";
```

**DON'T:**

```typescript
// Don't import from src/
import { foo } from "../src/code/skeleton.js";

// Don't omit .js extension (ESM requirement)
import { foo } from "../dist/code/skeleton";
```

### Test Examples

#### Unit Test Example

```typescript
// tests/my-feature.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { myFunction } from "../dist/code/my-feature.js";

describe("My Feature", () => {
  it("should do something", () => {
    const result = myFunction("input");
    assert.strictEqual(result, "expected");
  });
});
```

#### Integration Test Example

```typescript
// tests/harness/my-test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("Integration Test", () => {
  it("should call tool", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/main.js"],
    });
    await client.connect(transport);

    const response = await client.request({
      method: "tools/call",
      params: { name: "sdl.symbol.search", arguments: {...} }
    });

    assert.ok(response.results);
    await client.close();
  });
});
```

## Test Environment

### Environment Variables

- `NODE_ENV=test`: Set automatically in harness tests
- `SDL_CONFIG`: Optional path to test configuration

### Fixtures

Test fixtures go in `tests/fixtures/`:

```typescript
import { join } from "path";
import { readFileSync } from "fs";

const fixturePath = join(process.cwd(), "tests/fixtures", "test-file.ts");
const content = readFileSync(fixturePath, "utf-8");
```

### Golden Tests

Golden tests store expected outputs for regression testing.

#### E2E Golden Files (`tests/golden/`)

MCP tool golden files are stored in `tests/golden/`:

```json
{
  "name": "search-symbols",
  "description": "Search for symbols",
  "tool": "sdl.symbol.search",
  "request": { "repoId": "test-repo", "query": "foo", "limit": 10 },
  "expectedResponse": {
    "results": "array",
    "totalCount": "number"
  }
}
```

#### Language Adapter Golden Files (`tests/fixtures/{language}/`)

Adapter golden files store expected extraction results for each language:

- `expected-symbols.json` (or `expected-symbols.{ext}.json` for C/C++)
- `expected-imports.json`
- `expected-calls.json`

#### Golden File Management

Use the golden file manager to generate and validate golden files:

```bash
# Validate all golden files (runs on tests)
npm run test:golden

# Regenerate all golden files (use after adapter changes)
npm run golden:update

# Generate golden files for specific language
npm run golden:update rust

# Validate specific language
npm run test:golden rust
```

**Note**: Only regenerate golden files when making intentional changes to adapter behavior. Golden files prevent regressions by comparing extraction results against expected outputs.

## Troubleshooting

### "Cannot find module" errors

Ensure you've built before running tests:

```bash
npm run build:all
npm test
```

### Tests fail locally but pass in CI

Check for:

- Windows path differences (use `src/util/paths.ts`)
- Node version mismatch (CI runs 18.x and 20.x)
- Missing environment variables

### Test imports failing

Verify:

- Imports use `.js` extension
- Imports reference `dist/` not `src/`
- Build completed successfully (`ls dist/`)

## Coverage

Current test coverage:

- Skeleton generation: Unit tests in `tests/skeleton.test.ts`
- Skeleton determinism: `tests/skeleton-determinism.test.ts`
- MCP tools: Integration tests in `tests/harness/`
- Client profiles: `tests/harness/client-assertions.ts`

## Adding New Tests

1. Create test file in `tests/*.test.ts`
2. Import from `dist/` with `.js` extension
3. Use `node:test` API (`describe`, `it`, `beforeEach`, `afterEach`)
4. Run `npm test` to verify

For integration tests:

1. Add test logic to `tests/harness/runner.ts` or create new harness module
2. Import from MCP SDK
3. Spawn server via `dist/main.js`
4. Run via `npm run test:harness`

## Test Dependencies

Required devDependencies:

- `node:test` (built-in, Node.js 18+)
- `@modelcontextprotocol/sdk` (MCP client SDK)
- `zod` (schema validation)

No additional test runner needed (uses Node.js built-in).
