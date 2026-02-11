# SDL-MCP Testing Guide

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Guide for testing SDL-MCP across all supported languages: TypeScript, JavaScript, Python, Go, Java, C#, C, C++, PHP, Rust, Kotlin, and Shell.

---

## Table of Contents

1. [Test Strategy](#test-strategy)
2. [Running Tests](#running-tests)
3. [Multi-Language Testing](#multi-language-testing)
4. [Golden File Testing](#golden-file-testing)
5. [CI/CD Configuration](#cicd-configuration)
6. [Language-Specific Testing](#language-specific-testing)
7. [Troubleshooting Tests](#troubleshooting-tests)

---

## Test Strategy

SDL-MCP uses a **dist-first** testing strategy to ensure tests validate the shipped code.

### Why Dist-First?

- **Production accuracy**: Tests run against the actual artifacts that will be shipped
- **Build verification**: Ensures the build process works correctly
- **Type checking**: Tests use compiled TypeScript with type validation

### Test Layers

```
Integration Tests (multi-language end-to-end)
  |
Unit Tests (individual adapters and extractors)
  |
Golden File Tests (fixture output validation)
```

---

## Running Tests

### All Tests

SDL-MCP tests rely on `dist/` for some runtime entrypoints (for example, DB migrations). Build first, then run tests.

```bash
npm run build
npm test
```

### Test Harness

The test harness runs E2E tests with the actual MCP server:

```bash
npm run test:harness
```

### Specific Test Files

Run any `tests/**/*.test.ts` file with Node's test runner and the `tsx` loader:

```bash
node --import tsx --test tests/unit/pr-risk-analysis.test.ts
node --import tsx --test tests/integration/java-adapter.test.ts
```

### Watch Mode

```bash
# Watch all tests
node --import tsx --test --watch

# Watch specific test
node --import tsx --test --watch tests/unit/pr-risk-analysis.test.ts
```

### With Coverage

```bash
node --import tsx --test --experimental-test-coverage
```

---

## Multi-Language Testing

### Testing All Languages Together

Run all adapter tests:

```bash
npm test tests/unit/*-adapter.test.ts
```

### Testing Cross-Language Functionality

Test the adapter registry:

```bash
npm test tests/unit/adapter-registry.test.ts
```

This test verifies:

- All adapters are registered correctly
- Extensions map to the right adapters
- Invalid extensions return `null`

### Testing Polyglot Repository Indexing

1. Create a test repository with multiple languages:

```bash
mkdir /tmp/test-polyglot
cd /tmp/test-polyglot

# TypeScript
cat > index.ts << 'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOF

# Python
cat > utils.py << 'EOF'
def process_data(data):
    return [item * 2 for item in data]
EOF

# Go
cat > main.go << 'EOF'
package main

func main() {
    println("Hello from Go")
}
EOF

# Java
cat > Main.java << 'EOF'
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello from Java");
    }
}
EOF
```

2. Create test config:

```json
{
  "repos": [
    {
      "repoId": "test-polyglot",
      "rootPath": "/tmp/test-polyglot",
      "languages": ["ts", "py", "go", "java"]
    }
  ],
  "dbPath": "/tmp/test-polyglot/sdlmcp.sqlite",
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

3. Index and verify:

```bash
sdl-mcp index -c /tmp/test-polyglot/config.json
```

Expected output should show:

- 4 files indexed
- Symbols extracted from each language
- No errors during indexing

---

## Golden File Testing

### What Are Golden Files?

Golden files are expected JSON outputs for extraction tests. They ensure that:

- Symbol extraction produces consistent results
- Schema changes don't break extraction
- All language adapters follow the same format

### Golden File Locations

```
tests/fixtures/
  c/
  cpp/
  csharp/
  go/
  java/
  kotlin/
  php/
  rust/
  shell/
```

Most fixture folders include `expected-*.json` files. The Go fixtures currently do not include golden JSON outputs.

### Updating Golden Files

After modifying an adapter, update golden files:

```bash
# Validate current golden files
npm run test:golden

# Regenerate golden files (when an intentional change occurred)
npm run golden:update

# Optional: limit to a specific language supported by the golden manager script
npx tsx scripts/golden/update-goldens.ts generate rust
```

The golden manager script currently supports: `c`, `cpp`, `kotlin`, `php`, `rust`, and `shell`.

### Golden File Structure

**expected-symbols.json**:

```json
[
  {
    "nodeId": "string",
    "kind": "function|class|method|variable|interface|type|module",
    "name": "string",
    "exported": true,
    "range": {
      "startLine": 1,
      "startCol": 0,
      "endLine": 10,
      "endCol": 1
    },
    "signature": {},
    "visibility": "public|private|protected|internal"
  }
]
```

**expected-imports.json**:

```json
[
  {
    "specifier": "string",
    "isRelative": true,
    "isExternal": false,
    "imports": ["string"],
    "isReExport": false
  }
]
```

**expected-calls.json**:

```json
[
  {
    "callerNodeId": "string",
    "calleeIdentifier": "string",
    "isResolved": false,
    "callType": "function|method",
    "calleeSymbolId": "string",
    "range": {
      "startLine": 1,
      "startCol": 0,
      "endLine": 1,
      "endCol": 10
    }
  }
]
```

---

## CI/CD Configuration

### GitHub Actions

SDL-MCP uses GitHub Actions for CI. See `.github/workflows/ci.yml`.

**Test Steps in CI**:

```yaml
- name: Install dependencies
  run: npm ci

- name: Build project
  run: npm run build

- name: Run tests
  run: npm test

- name: Run test harness
  run: npm run test:harness
```

### Windows vs Linux Differences

#### Path Separators

Golden files use forward slashes internally, but the test framework handles both:

```typescript
// Platform-agnostic path comparison
const normalizedPath = filePath.replace(/\\/g, "/");
```

#### Tree-sitter Grammars

All tree-sitter grammars compile on both platforms. CI tests verify:

```typescript
// tests/integration/grammar-loading.test.ts
const languages: SupportedLanguage[] = [
  "typescript",
  "python",
  "go",
  "java",
  "csharp",
  "c",
  "cpp",
  "php",
  "rust",
  "kotlin",
  "bash",
];

for (const lang of languages) {
  const parser = getParser(lang);
  assert.ok(parser, `${lang} parser should load`);
}
```

---

## Language-Specific Testing

### TypeScript/JavaScript

**Test Files**:

- `tests/unit/ts-parser.test.ts`
- `tests/fixtures/typescript/`

**Key Test Areas**:

- Type inference for signatures
- JSX/TSX support
- JSDoc comment extraction
- CommonJS and ESM modules

**Example Test**:

```typescript
test("extracts TypeScript class with decorators", async () => {
  const adapter = new TypeScriptAdapter();
  const tree = adapter.parse("export @Component class App {}");
  const symbols = adapter.extractSymbols(tree, "", "test.ts");

  assert.equal(symbols[0].name, "App");
  assert.equal(symbols[0].decorators.length, 1);
});
```

### Python

**Test Files**:

- `tests/unit/python-adapter.test.ts`
- `tests/fixtures/python/`

**Key Test Areas**:

- Function definitions with type hints
- Class definitions and inheritance
- Decorator metadata
- Import styles (relative, wildcard, aliased)

**Example Test**:

```typescript
test("extracts Python function with decorators", async () => {
  const adapter = new PythonAdapter();
  const tree = adapter.parse('@app.route("/")\ndef index():\n    pass');
  const symbols = adapter.extractSymbols(tree, "", "test.py");

  assert.equal(symbols[0].decorators[0], "@app.route");
});
```

### Go

**Test Files**:

- `tests/unit/go-adapter.test.ts`
- `tests/fixtures/go/`

**Key Test Areas**:

- Package declarations
- Functions with receivers (methods)
- Import block parsing
- Export by capitalization

**Example Test**:

```typescript
test("extracts Go method with receiver", async () => {
  const adapter = new GoAdapter();
  const tree = adapter.parse("func (s *Service) Process() {}");
  const symbols = adapter.extractSymbols(tree, "", "test.go");

  assert.equal(symbols[0].name, "Process");
  assert.equal(symbols[0].signature.receiver, "*Service");
});
```

### Java

**Test Files**:

- `tests/unit/java-adapter.test.ts`
- `tests/fixtures/java/`

**Key Test Areas**:

- Class, interface, enum definitions
- Method signatures with generics
- Import statements (wildcard, static)
- Annotations

**Example Test**:

```typescript
test("extracts Java class with annotations", async () => {
  const adapter = new JavaAdapter();
  const tree = adapter.parse("@Entity\npublic class User {}");
  const symbols = adapter.extractSymbols(tree, "", "test.java");

  assert.equal(symbols[0].name, "User");
  assert.equal(symbols[0].decorators[0], "@Entity");
});
```

### C#

**Test Files**:

- `tests/unit/csharp-adapter.test.ts`
- `tests/fixtures/csharp/`

**Key Test Areas**:

- Namespace declarations
- Properties with accessors
- Async/await tracking
- Attribute (decorator) capture

**Example Test**:

```typescript
test("extracts C# property with accessors", async () => {
  const adapter = new CSharpAdapter();
  const tree = adapter.parse("public string Name { get; set; }");
  const symbols = adapter.extractSymbols(tree, "", "test.cs");

  assert.equal(symbols[0].name, "Name");
  assert.equal(symbols[0].kind, "property");
});
```

### C

**Test Files**:

- `tests/unit/c-adapter.test.ts`
- `tests/fixtures/c/`

**Key Test Areas**:

- Preprocessor directives (#define, #include)
- Struct and union definitions
- Function pointers
- Header file relationships

**Example Test**:

```typescript
test("extracts C struct definition", async () => {
  const adapter = new CAdapter();
  const tree = adapter.parse("struct Point { int x; int y; };");
  const symbols = adapter.extractSymbols(tree, "", "test.c");

  assert.equal(symbols[0].name, "Point");
  assert.equal(symbols[0].kind, "class");
});
```

### C++

**Test Files**:

- `tests/unit/cpp-adapter.test.ts`
- `tests/fixtures/cpp/`

**Key Test Areas**:

- Template parameters and specializations
- Namespace hierarchies
- Class inheritance (single/multiple)
- STL container usage patterns

**Example Test**:

```typescript
test("extracts C++ template function", async () => {
  const adapter = new CppAdapter();
  const tree = adapter.parse(
    "template<typename T> T max(T a, T b) { return a > b ? a : b; }",
  );
  const symbols = adapter.extractSymbols(tree, "", "test.cpp");

  assert.equal(symbols[0].name, "max");
  assert.equal(symbols[0].signature.params[0].type, "T");
});
```

### PHP

**Test Files**:

- `tests/unit/php-adapter.test.ts`
- `tests/fixtures/php/`

**Key Test Areas**:

- Class and trait definitions
- Namespace and use statements
- Property visibility
- Anonymous classes

**Example Test**:

```typescript
test("extracts PHP class with traits", async () => {
  const adapter = new PhpAdapter();
  const tree = adapter.parse(
    "class User { use Loggable; public function getName() { return $this->name; } }",
  );
  const symbols = adapter.extractSymbols(tree, "", "test.php");

  assert.equal(symbols[0].name, "User");
  assert.equal(symbols[0].decorators.length, 1);
});
```

### Rust

**Test Files**:

- `tests/unit/rust-adapter.test.ts`
- `tests/fixtures/rust/`

**Key Test Areas**:

- Lifetime parameters
- Trait implementations
- Module path resolution
- Macro invocations

**Example Test**:

```typescript
test("extracts Rust struct with lifetimes", async () => {
  const adapter = new RustAdapter();
  const tree = adapter.parse("struct Ref<'a, T: 'a> { value: &'a T; }");
  const symbols = adapter.extractSymbols(tree, "", "test.rs");

  assert.equal(symbols[0].name, "Ref");
});
```

### Kotlin

**Test Files**:

- `tests/unit/kotlin-adapter.test.ts`
- `tests/fixtures/kotlin/`

**Key Test Areas**:

- Property accessors (get/set)
- Coroutines and suspend functions
- Companion objects
- Extension functions

**Example Test**:

```typescript
test("extracts Kotlin suspend function", async () => {
  const adapter = new KotlinAdapter();
  const tree = adapter.parse(
    'suspend fun fetchData(): String { return "data" }',
  );
  const symbols = adapter.extractSymbols(tree, "", "test.kt");

  assert.equal(symbols[0].name, "fetchData");
  assert.equal(symbols[0].signature.async, true);
});
```

### Shell

**Test Files**:

- `tests/unit/shell-adapter.test.ts`
- `tests/fixtures/shell/`

**Key Test Areas**:

- Function definitions
- Variable assignments
- Command aliases
- Shebang detection

**Example Test**:

```typescript
test("extracts Shell function", async () => {
  const adapter = new ShellAdapter();
  const tree = adapter.parse('greet() { echo "Hello" }');
  const symbols = adapter.extractSymbols(tree, "", "test.sh");

  assert.equal(symbols[0].name, "greet");
  assert.equal(symbols[0].kind, "function");
});
```

---

## Troubleshooting Tests

### "Module not found" Errors

**Cause**: Dist artifacts not built.

**Solution**:

```bash
npm run build
npm test
```

### Golden File Mismatches

**Cause**: Expected output changed after adapter modification.

**Solution**:

1. Review the diff to understand what changed
2. If the change is intentional, update the golden file
3. If unexpected, debug the adapter

### Grammar Loading Failures

**Cause**: Native dependencies not compiled for your platform.

**Solution**:

```bash
npm rebuild
# or
npm install --build-from-source
```

### Windows Path Issues

**Cause**: Backslash vs forward slash in paths.

**Solution**: Tests should normalize paths:

```typescript
// Always normalize paths in tests
const normalized = filePath.replace(/\\/g, "/");
```

### Tree-sitter Parse Errors

**Cause**: Test fixture has invalid syntax.

**Solution**:

1. Validate fixture syntax with a language linter
2. Check tree-sitter query patterns
3. Verify grammar version is correct

### Memory Issues During Tests

**Cause**: Large test fixtures or memory leaks.

**Solution**:

1. Reduce fixture size
2. Clear parser cache between tests:

```typescript
import { clearCache } from "../src/indexer/treesitter/grammarLoader.js";

afterEach(() => {
  clearCache();
});
```

### CI Failures on Linux Only

**Cause**: Platform-specific differences.

**Common Issues**:

- File permissions
- Path case sensitivity
- Unicode handling

**Solution**:

1. Reproduce locally in a Linux container:
   ```bash
   docker run -it node:20 bash
   ```
2. Add platform checks in tests if needed
3. Use `fs.constants` for cross-platform file operations

---

## Adding New Language Support

When adding a new language:

1. **Create test fixtures**:

   ```bash
   mkdir tests/fixtures/newlang
   # Create symbols.newlang, imports.newlang, calls.newlang
   ```

2. **Create adapter tests**:

   ```bash
   touch tests/unit/newlang-adapter.test.ts
   ```

3. **Generate golden files**:

   ```bash
   # 1) Add the adapter to scripts/golden/update-goldens.ts (ADAPTERS map)
   # 2) Add fixtures under tests/fixtures/newlang/
   # 3) Regenerate goldens
   npm run golden:update
   ```

4. **Update CI configuration**:
   - Ensure the new grammar compiles on all platforms
   - Add test timeout if indexing is slow

5. **Update this guide**:
   - Add language-specific testing section
   - Document any quirks or limitations

---

## Test Coverage

### Current Coverage

Run with coverage:

```bash
node --import tsx --test --experimental-test-coverage
```

### Coverage Goals

- **Adapters**: 90%+ coverage for all extraction logic
- **Indexer**: 85%+ coverage
- **Core**: 80%+ coverage for database and graph logic

### Exclusions

- Generated code (e.g., grammar bindings)
- CLI entry points (difficult to unit test)
- Error handling paths that require system failures

---

## Performance Testing

### Benchmarking

Run the real-world benchmark:

```bash
npm run benchmark:real
```

### Test Fixture Performance

Golden file tests should complete in:

- **Symbol extraction**: < 100ms per file
- **Import extraction**: < 50ms per file
- **Call extraction**: < 100ms per file

### Profiling Slow Tests

```bash
# Run with Node profiler
node --prof --test tests/unit/python-adapter.test.ts

# Analyze output
node --prof-process isolate-*.log > profile.txt
```

---

## Best Practices

1. **Test isolated functionality**: Each test should verify one thing
2. **Use descriptive names**: `test('extracts Python function with type hints')`
3. **Avoid testing implementation**: Test behavior, not internal details
4. **Keep fixtures small**: Test specific patterns, not entire files
5. **Document test intentions**: Explain _why_ something is tested
6. **Maintain golden files**: Update them when adapters change
7. **Run tests before committing**: `npm test` should always pass

---

## Getting Help

- **Test failures**: Check CI logs for full error messages
- **Adapter issues**: See implementation in `src/indexer/adapter/`
- **Grammar problems**: Consult tree-sitter query documentation
- **Platform issues**: Check GitHub Actions for Linux-specific failures
