# Example Adapter Plugin

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Plugin SDK Author Guide](../../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
  - [Plugin SDK Security](../../docs/PLUGIN_SDK_SECURITY.md)
- [Plugin Templates](../../templates/README.md)
- [Example Plugin (this page)](./README.md)

</details>
</div>

This is a demonstration plugin for SDL-MCP's adapter plugin system. It shows how to create a custom language adapter that can be loaded at runtime without modifying the core SDL-MCP codebase.

## What This Plugin Does

The example plugin provides support for a hypothetical ".ex" file extension ("example-lang"). It demonstrates:

- **Symbol extraction**: Finds functions and classes using simple regex patterns
- **Import extraction**: Identifies import statements
- **Call extraction**: Detects function calls to extracted symbols

## Plugin Structure

```typescript
export const manifest = {
  name: "example-plugin",
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "Example adapter plugin demonstrating the plugin system",
  author: "SDL-MCP Team",
  license: "MIT",
  adapters: [
    {
      extension: ".ex",
      languageId: "example-lang",
    },
  ],
};
```

The manifest defines:

- Plugin metadata (name, version, author, etc.)
- API version compatibility (must match host's major version)
- List of supported file extensions and language IDs

## Required Exports

Every plugin must export:

1. **`manifest`**: Plugin metadata object
2. **`createAdapters()`**: Function that returns an array of adapter descriptors

### Adapter Descriptor

Each adapter descriptor must provide:

- `extension`: File extension (e.g., `.ex`)
- `languageId`: Unique identifier for the language
- `factory`: Function that creates a new `LanguageAdapter` instance

## Creating Your Own Plugin

### 1. Create a new directory

```bash
mkdir my-custom-plugin
cd my-custom-plugin
```

### 2. Initialize package.json

```json
{
  "name": "my-custom-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "dependencies": {
    "sdl-mcp": "latest"
  }
}
```

### 3. Create your plugin

Copy the structure from this example and modify:

- The `manifest` metadata
- The adapter implementation
- The symbol/import/call extraction logic

### 4. Build your plugin

**Note**: Building the example plugin requires SDL-MCP to be available. For local development, the example plugin uses relative imports to the SDL-MCP source code.

```bash
# From SDL-MCP root directory
npm install
npm run build

# Then build the example plugin
cd examples/example-plugin
npm install
npm run build
```

If SDL-MCP is published to NPM, you can also install it as a dependency:

```bash
npm install sdl-mcp
npm run build
```

### 5. Register in SDL-MCP config

Add your plugin to `config/sdlmcp.config.json`:

```json
{
  "repos": [...],
  "plugins": {
    "paths": ["/path/to/your/plugin/dist/index.js"],
    "enabled": true,
    "strictVersioning": true
  }
}
```

## LanguageAdapter Interface

Your adapter must implement the `LanguageAdapter` interface:

```typescript
interface LanguageAdapter {
  languageId: string;
  fileExtensions: readonly string[];
  getParser(): any;
  parse(content: string, filePath: string): Tree | null;
  extractSymbols(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedSymbol[];
  extractImports(
    tree: Tree,
    content: string,
    filePath: string,
  ): ExtractedImport[];
  extractCalls(
    tree: Tree,
    content: string,
    filePath: string,
    extractedSymbols: ExtractedSymbol[],
  ): ExtractedCall[];
}
```

### Using BaseAdapter

For convenience, extend `BaseAdapter` which provides:

- Tree-sitter parser management
- Parse error handling
- Common utility methods

```typescript
import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";

class MyAdapter extends BaseAdapter {
  languageId = "my-lang" as const;
  fileExtensions = [".my"] as const;

  // Implement abstract methods
  extractSymbols(...): ExtractedSymbol[] { /* ... */ }
  extractImports(...): ExtractedImport[] { /* ... */ }
  extractCalls(...): ExtractedCall[] { /* ... */ }
}
```

## API Version Compatibility

The plugin system uses semantic versioning for API compatibility:

- **Major versions must match** (e.g., plugin API 1.x requires host API 1.x)
- Minor and patch versions can differ
- Set `strictVersioning: false` in config to allow major version mismatches (not recommended)

## Testing Your Plugin

Create test files with your extension:

```ex
// example.ex
import "stdlib"

class MyClass:
  fn myMethod():
    print("Hello, world!")
```

Then run SDL-MCP indexing:

```bash
sdl-mcp index
```

Check logs for plugin loading status and any errors.

## Common Patterns

### Simple Regex-based Extraction

For simple languages, use regex patterns like this example:

```typescript
extractSymbols(_tree, content, filePath) {
  const symbols = [];
  content.split('\n').forEach((line, index) => {
    const match = line.match(/pattern/);
    if (match) {
      symbols.push({
        id: `${filePath}:symbol:${match[1]}`,
        name: match[1],
        kind: "function",
        filePath,
        range: { /* ... */ },
        parentId: null,
        metadata: {},
      });
    }
  });
  return symbols;
}
```

### Tree-sitter Based Extraction

For complex languages, use tree-sitter grammars:

```typescript
import { getParser } from "sdl-mcp/dist/indexer/treesitter/grammarLoader.js";

class TreeSitterAdapter extends BaseAdapter {
  extractSymbols(tree, content, filePath) {
    const symbols = [];
    const query = this.getParser().getLanguage().query(`
      (function_declaration name: (_) @name)
    `);

    const captures = query.captures(tree.rootNode);
    for (const [node, name] of captures) {
      if (name === "name") {
        symbols.push({
          id: `${filePath}:${node.text}`,
          name: node.text,
          kind: "function",
          filePath,
          range: this.extractRange(node),
          parentId: null,
          metadata: {},
        });
      }
    }

    return symbols;
  }
}
```

## Troubleshooting

### Plugin Not Loading

Check SDL-MCP logs for error messages:

- Verify plugin path is correct
- Ensure manifest has all required fields
- Check API version compatibility

### Adapters Not Working

- Verify extension matches files in your repo
- Check that `createAdapters()` returns valid adapter descriptors
- Ensure factory function creates adapter instances correctly

### Version Errors

- Update plugin's `apiVersion` to match host
- Or set `strictVersioning: false` (not recommended for production)

## Further Reading

- [SDL-MCP README](../../README.md)
- [LanguageAdapter Interface](../../src/indexer/adapter/LanguageAdapter.ts)
- [BaseAdapter Implementation](../../src/indexer/adapter/BaseAdapter.ts)
- [Plugin Types](../../src/indexer/adapter/plugin/types.ts)
