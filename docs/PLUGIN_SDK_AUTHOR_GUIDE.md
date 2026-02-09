# Adapter Plugin SDK - Author Guide

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

Complete guide for creating, packaging, configuring, and troubleshooting SDL-MCP adapter plugins.

## Table of Contents

- [Quick Start](#quick-start)
- [Plugin Structure](#plugin-structure)
- [Creating a Plugin](#creating-a-plugin)
- [Packaging](#packaging)
- [Configuration](#configuration)
- [Testing](#testing)
- [Distribution](#distribution)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

## Quick Start

Create a new plugin in 5 minutes:

```bash
# 1. Create plugin directory
mkdir my-lang-plugin
cd my-lang-plugin

# 2. Initialize package.json
npm init -y

# 3. Create plugin (see examples below)
# Create index.ts with your adapter implementation

# 4. Build plugin
npm run build

# 5. Register in SDL-MCP config
# Add to config/sdlmcp.config.json:
{
  "plugins": {
    "paths": ["./my-lang-plugin/dist/index.js"],
    "enabled": true
  }
}

# 6. Test
sdl-mcp index
```

## Plugin Structure

A minimal plugin has the following structure:

```
my-plugin/
├── package.json          # NPM package metadata
├── tsconfig.json         # TypeScript configuration
├── index.ts             # Plugin entry point
├── README.md            # Plugin documentation
└── dist/                # Compiled output (generated)
    └── index.js
```

### Required Exports

Every plugin must export:

1. **`manifest`**: Plugin metadata object
2. **`createAdapters()`**: Factory function returning adapter descriptors

```typescript
export const manifest = {
  name: "my-plugin",
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "My custom language adapter",
  author: "Your Name",
  license: "MIT",
  adapters: [
    {
      extension: ".mylang",
      languageId: "mylang",
    },
  ],
};

export async function createAdapters() {
  return [
    {
      extension: ".mylang",
      languageId: "mylang",
      factory: () => new MyLangAdapter(),
    },
  ];
}

export default { manifest, createAdapters };
```

## Creating a Plugin

### Step 1: Initialize Project

```bash
mkdir my-lang-plugin
cd my-lang-plugin
npm init -y
```

Update `package.json`:

```json
{
  "name": "sdl-mcp-my-lang-plugin",
  "version": "1.0.0",
  "description": "MyLang adapter plugin for SDL-MCP",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["sdl-mcp", "plugin", "adapter", "mylang"],
  "author": "Your Name",
  "license": "MIT",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.9.3"
  },
  "peerDependencies": {
    "sdl-mcp": "*"
  }
}
```

### Step 2: Configure TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["index.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 3: Implement Adapter

Create `index.ts`:

```typescript
import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";
import type {
  LanguageAdapter,
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "sdl-mcp/dist/indexer/adapter/LanguageAdapter.js";
import type {
  AdapterPlugin,
  PluginAdapter,
} from "sdl-mcp/dist/indexer/adapter/plugin/types.js";

export const manifest = {
  name: "my-lang-plugin",
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "MyLang adapter plugin for SDL-MCP",
  author: "Your Name",
  license: "MIT",
  adapters: [
    {
      extension: ".mylang",
      languageId: "mylang",
    },
  ],
};

class MyLangAdapter extends BaseAdapter {
  languageId = "mylang" as const;
  fileExtensions = [".mylang"] as const;

  extractSymbols(
    _tree: any,
    content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const funcMatch = line.match(/function\s+(\w+)/);
      if (funcMatch) {
        symbols.push({
          id: `${filePath}:fn:${funcMatch[1]}`,
          name: funcMatch[1],
          kind: "function",
          filePath,
          range: {
            startLine: index + 1,
            startCol: line.indexOf(funcMatch[1]),
            endLine: index + 1,
            endCol: line.indexOf(funcMatch[1]) + funcMatch[1].length,
          },
          parentId: null,
          metadata: {},
        });
      }
    });

    return symbols;
  }

  extractImports(
    _tree: any,
    content: string,
    filePath: string,
  ): ExtractedImport[] {
    const imports: ExtractedImport[] = [];

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const importMatch = line.match(/import\s+"(.+)"/);
      if (importMatch) {
        imports.push({
          id: `${filePath}:import:${index}`,
          filePath,
          range: {
            startLine: index + 1,
            startCol: line.indexOf("import"),
            endLine: index + 1,
            endCol: line.length,
          },
          moduleName: importMatch[1],
          symbols: [],
        });
      }
    });

    return imports;
  }

  extractCalls(
    _tree: any,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[] {
    const calls: ExtractedCall[] = [];

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const callMatch = line.match(/(\w+)\s*\(/);
      if (callMatch) {
        const functionName = callMatch[1];
        const symbol = extractedSymbols.find((s) => s.name === functionName);

        if (symbol) {
          calls.push({
            id: `${filePath}:call:${index}:${functionName}`,
            filePath,
            range: {
              startLine: index + 1,
              startCol: line.indexOf(functionName),
              endLine: index + 1,
              endCol: line.indexOf(functionName) + functionName.length,
            },
            targetSymbolId: symbol.id,
          });
        }
      }
    });

    return calls;
  }
}

export async function createAdapters(): Promise<PluginAdapter[]> {
  return [
    {
      extension: ".mylang",
      languageId: "mylang",
      factory: () => new MyLangAdapter(),
    },
  ];
}

export default { manifest, createAdapters };
```

### Step 4: Build Plugin

```bash
npm install
npm run build
```

Verify the output:

```bash
ls dist/
# Should see: index.js, index.d.ts
```

## Packaging

### Standard Package Structure

Your published plugin should include:

```
sdl-mcp-my-lang-plugin-1.0.0.tgz
├── dist/
│   ├── index.js
│   └── index.d.ts
├── package.json
├── README.md
└── LICENSE
```

### Files to Include

Update `package.json`:

```json
{
  "files": ["dist", "README.md", "LICENSE"]
}
```

### Publishing to NPM

```bash
# 1. Login to NPM
npm login

# 2. Publish
npm publish

# 3. Verify
npm view sdl-mcp-my-lang-plugin
```

### Alternative: Local Distribution

For internal use without NPM:

```bash
# Create tarball
npm pack

# Install from local tarball
npm install sdl-mcp-my-lang-plugin-1.0.0.tgz

# Or install from directory
npm install ./my-lang-plugin
```

## Configuration

### SDL-MCP Config File

Add plugin to `config/sdlmcp.config.json`:

```json
{
  "repos": [
    {
      "id": "my-repo",
      "path": "/path/to/repo"
    }
  ],
  "plugins": {
    "paths": ["./my-lang-plugin/dist/index.js"],
    "enabled": true,
    "strictVersioning": true
  }
}
```

### Configuration Options

#### `plugins.paths` (required, array)

Array of plugin file paths. Each path can be:

- Absolute: `/usr/local/lib/sdl-mcp-plugins/my-plugin/dist/index.js`
- Relative to config dir: `./plugins/my-plugin/dist/index.js`
- Relative to cwd: `my-plugin/dist/index.js`

#### `plugins.enabled` (optional, boolean)

Enable or disable plugin loading. Default: `true`

```json
{
  "plugins": {
    "paths": ["./plugin1.js"],
    "enabled": false
  }
}
```

#### `plugins.strictVersioning` (optional, boolean)

Require exact API version match. Default: `true`

Set to `false` to allow compatible API versions (same major version).

```json
{
  "plugins": {
    "paths": ["./plugin1.js"],
    "strictVersioning": false
  }
}
```

### Multiple Plugins

```json
{
  "plugins": {
    "paths": [
      "./plugins/plugin1/dist/index.js",
      "./plugins/plugin2/dist/index.js",
      "./plugins/plugin3/dist/index.js"
    ],
    "enabled": true
  }
}
```

### Environment-Specific Configs

#### Development

```json
{
  "plugins": {
    "paths": ["./my-lang-plugin/dist/index.js"],
    "enabled": true,
    "strictVersioning": false
  }
}
```

#### Production

```json
{
  "plugins": {
    "paths": ["/usr/local/lib/sdl-mcp-plugins/my-lang-plugin/dist/index.js"],
    "enabled": true,
    "strictVersioning": true
  }
}
```

## Testing

### Unit Testing

Create `test/plugin.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { MyLangAdapter } from "../dist/index.js";

describe("MyLang Adapter", () => {
  const adapter = new MyLangAdapter();

  it("should extract functions", () => {
    const content = "function myFunc() {}";
    const symbols = adapter.extractSymbols(null, content, "test.my");

    assert.ok(symbols.find((s) => s.name === "myFunc"));
  });

  it("should extract imports", () => {
    const content = 'import "stdlib"';
    const imports = adapter.extractImports(null, content, "test.my");

    assert.strictEqual(imports.length, 1);
    assert.strictEqual(imports[0].moduleName, "stdlib");
  });

  it("should extract calls", () => {
    const content = "function myFunc() {}\nmyFunc()";
    const symbols = adapter.extractSymbols(null, content, "test.my");
    const calls = adapter.extractCalls(null, content, "test.my", symbols);

    assert.ok(calls.length > 0);
  });
});
```

Run tests:

```bash
npm test
```

### Integration Testing

Use SDL-MCP's integration test framework:

```bash
# 1. Build plugin
npm run build

# 2. Configure SDL-MCP with plugin
# Add to config/sdlmcp.config.json

# 3. Create test fixtures
mkdir test-fixtures
echo 'function test() {}' > test-fixtures/test.my

# 4. Run SDL-MCP index
sdl-mcp index

# 5. Check output for plugin loading
# Look for logs like:
# "Plugin loaded successfully: my-lang-plugin@1.0.0"
```

### Golden File Testing

Create expected outputs and validate:

```typescript
import { writeFileSync, readFileSync } from "fs";

describe("Golden File Tests", () => {
  it("should match expected symbols", () => {
    const content = "function test() {}";
    const symbols = adapter.extractSymbols(null, content, "test.my");

    const golden = JSON.parse(readFileSync("test/expected-symbols.json"));
    assert.deepStrictEqual(symbols, golden);
  });

  it("should generate golden file", () => {
    const content = "function test() {}";
    const symbols = adapter.extractSymbols(null, content, "test.my");

    writeFileSync(
      "test/expected-symbols.json",
      JSON.stringify(symbols, null, 2),
    );
  });
});
```

## Distribution

### NPM Registry

1. **Publish to public NPM**:

   ```bash
   npm publish --access public
   ```

2. **Publish to private registry**:

   ```bash
   npm publish --registry https://npm.yourcompany.com
   ```

3. **Scoped packages**:
   ```bash
   npm publish --access public
   ```

### Git Distribution

Share plugin via Git:

```bash
# 1. Create Git repository
git init
git add .
git commit -m "Initial plugin"
git remote add origin https://github.com/user/my-lang-plugin.git
git push

# 2. Users can install via Git
npm install https://github.com/user/my-lang-plugin.git

# 3. Or use npx
npx sdl-mcp --plugin https://github.com/user/my-lang-plugin.git
```

### Private Distribution

#### Internal NPM Registry

```bash
# Publish to internal registry
npm publish --registry https://npm.yourcompany.com

# Install from internal registry
npm install --registry https://npm.yourcompany.com sdl-mcp-my-lang-plugin
```

#### File System Distribution

```bash
# Copy to shared directory
cp -r my-lang-plugin /shared/sdl-mcp-plugins/

# Reference in config
{
  "plugins": {
    "paths": ["/shared/sdl-mcp-plugins/my-lang-plugin/dist/index.js"]
  }
}
```

## Troubleshooting

### Plugin Not Loading

**Symptoms**: Plugin doesn't appear in logs, no errors

**Solutions**:

1. **Check file path**:

   ```bash
   # Verify plugin exists
   ls -la ./my-plugin/dist/index.js

   # Use absolute path if relative doesn't work
   pwd
   ```

2. **Check file permissions**:

   ```bash
   chmod +r ./my-plugin/dist/index.js
   ```

3. **Verify config syntax**:

   ```json
   {
     "plugins": {
       "paths": ["./my-plugin/dist/index.js"],
       "enabled": true
     }
   }
   ```

4. **Check SDL-MCP logs**:
   ```bash
   # Run with verbose logging
   sdl-mcp index --verbose
   ```

### Version Compatibility Errors

**Symptoms**: "Incompatible API version" error

**Solutions**:

1. **Check API versions**:

   ```typescript
   // Plugin manifest
   export const manifest = {
     apiVersion: "1.0.0", // Must match host
   };
   ```

2. **Check SDL-MCP version**:

   ```bash
   sdl-mcp --version
   ```

3. **Update plugin API version**:

   ```typescript
   // If SDL-MCP has API 1.1.0, use 1.x.x
   export const manifest = {
     apiVersion: "1.0.0", // Major version must match
   };
   ```

4. **Disable strict versioning** (not recommended):
   ```json
   {
     "plugins": {
       "paths": ["./my-plugin/dist/index.js"],
       "strictVersioning": false
     }
   }
   ```

### Manifest Validation Errors

**Symptoms**: "Invalid manifest" or specific field errors

**Solutions**:

1. **Verify required fields**:

   ```typescript
   export const manifest = {
     name: "my-plugin", // Required
     version: "1.0.0", // Required
     apiVersion: "1.0.0", // Required
     description: "...", // Optional
     author: "...", // Optional
     license: "MIT", // Optional
     adapters: [
       // Required
       {
         extension: ".my", // Required
         languageId: "mylang", // Required
       },
     ],
   };
   ```

2. **Check types**:
   - `name`: string, min 1 char
   - `version`: string, min 1 char
   - `apiVersion`: string, min 1 char
   - `adapters`: array, min 1 item

### Adapter Not Working

**Symptoms**: Plugin loads but files not indexed

**Solutions**:

1. **Check file extension**:

   ```typescript
   export const manifest = {
     adapters: [
       {
         extension: ".mylang", // Must match actual files
         languageId: "mylang",
       },
     ],
   };
   ```

2. **Verify adapter implementation**:

   ```typescript
   class MyAdapter extends BaseAdapter {
     languageId = "mylang" as const; // Must match
     fileExtensions = [".mylang"] as const; // Must match
   }
   ```

3. **Check adapter methods**:

   ```typescript
   // All methods must be implemented
   extractSymbols(tree, content, filePath): ExtractedSymbol[] {
     // Must return array
     return [];
   }

   extractImports(tree, content, filePath): ExtractedImport[] {
     // Must return array
     return [];
   }

   extractCalls(tree, content, filePath, symbols): ExtractedCall[] {
     // Must return array
     return [];
   }
   ```

4. **Test with simple file**:

   ```bash
   # Create test file
   echo 'function test() {}' > test.mylang

   # Run indexer
   sdl-mcp index

   # Check logs for errors
   ```

### Build Errors

**Symptoms**: TypeScript compilation fails

**Solutions**:

1. **Check TypeScript version**:

   ```bash
   npm list typescript
   # Should be >= 5.0.0
   ```

2. **Verify tsconfig.json**:

   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "outDir": "./dist"
     }
   }
   ```

3. **Check imports**:
   ```typescript
   // Use .js extension for ESM
   import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";
   ```

### Runtime Errors

**Symptoms**: Crashes during indexing

**Solutions**:

1. **Add error handling**:

   ```typescript
   extractSymbols(tree, content, filePath) {
     try {
       // Your extraction logic
     } catch (error) {
       console.error(`Error extracting symbols from ${filePath}:`, error);
       return [];
     }
   }
   ```

2. **Check for null/undefined**:

   ```typescript
   extractSymbols(tree, content, filePath) {
     if (!content) return [];
     if (!tree) return [];

     // Safe extraction
   }
   ```

3. **Validate data structures**:
   ```typescript
   if (!Array.isArray(symbols)) {
     console.error("extractSymbols must return array");
     return [];
   }
   ```

### Performance Issues

**Symptoms**: Indexing is slow

**Solutions**:

1. **Optimize regex patterns**:

   ```typescript
   // Bad: Greedy pattern
   const match = line.match(/function\s+.+\(/);

   // Good: Specific pattern
   const match = line.match(/function\s+(\w+)\s*\(/);
   ```

2. **Cache results**:

   ```typescript
   const cache = new Map();

   extractSymbols(tree, content, filePath) {
     if (cache.has(filePath)) {
       return cache.get(filePath);
     }

     const symbols = /* extract */;

     cache.set(filePath, symbols);
     return symbols;
   }
   ```

3. **Limit recursion depth**:

   ```typescript
   function extractSymbols(node, depth = 0) {
     if (depth > 100) return []; // Prevent stack overflow

     // Extract from node and children
   }
   ```

## Best Practices

### 1. Version Management

```typescript
// Use semantic versioning
export const manifest = {
  version: "1.2.3", // MAJOR.MINOR.PATCH
};

// MAJOR: Breaking API changes
// MINOR: New features, backward compatible
// PATCH: Bug fixes, backward compatible
```

### 2. Error Handling

```typescript
// Always handle errors gracefully
extractSymbols(tree, content, filePath) {
  try {
    return this.doExtract(tree, content, filePath);
  } catch (error) {
    console.error(`Plugin error in ${filePath}:`, error);
    return []; // Never crash the indexer
  }
}
```

### 3. Type Safety

```typescript
// Use TypeScript for type safety
import type {
  ExtractedSymbol,
  ExtractedImport,
  ExtractedCall,
} from "sdl-mcp/dist/indexer/adapter/LanguageAdapter.js";

// Type all return values
extractSymbols(/* ... */): ExtractedSymbol[] {
  return []; // Type-safe
}
```

### 4. Documentation

````typescript
/**
 * MyLang Adapter
 *
 * Supports extraction of symbols, imports, and calls from MyLang files.
 *
 * @example
 * ```typescript
 * const adapter = new MyLangAdapter();
 * const symbols = adapter.extractSymbols(tree, content, filePath);
 * ```
 */
class MyLangAdapter extends BaseAdapter {
  // ...
}
````

### 5. Testing

```typescript
// Write comprehensive tests
describe("MyLang Adapter", () => {
  it("extracts functions");
  it("extracts classes");
  it("extracts imports");
  it("extracts calls");
  it("handles errors gracefully");
  it("matches golden files");
});
```

### 6. Performance

```typescript
// Use efficient algorithms
// Cache when appropriate
// Avoid unnecessary computations

// Bad: O(n²)
for (const symbol1 of symbols) {
  for (const symbol2 of symbols) {
    // ...
  }
}

// Good: O(n)
const symbolMap = new Map(symbols.map((s) => [s.name, s]));
```

## Additional Resources

- [SDL-MCP README](../../README.md)
- [Plugin Types](../../src/indexer/adapter/plugin/types.ts)
- [BaseAdapter](../../src/indexer/adapter/BaseAdapter.ts)
- [LanguageAdapter Interface](../../src/indexer/adapter/LanguageAdapter.ts)
- [Example Plugin](../example-plugin/)
