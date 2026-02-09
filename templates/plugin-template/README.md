# MyLang Plugin for SDL-MCP

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Plugin SDK Author Guide](../../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
  - [Plugin SDK Security](../../docs/PLUGIN_SDK_SECURITY.md)
- [Templates Index](../README.md)
- [Plugin Template (this page)](./README.md)
- [Example Plugin](../../examples/example-plugin/README.md)

</details>
</div>

A template adapter plugin for SDL-MCP. Customize this to add support for your language.

## Quick Start

```bash
# 1. Copy this template
cp -r templates/plugin-template my-lang-plugin
cd my-lang-plugin

# 2. Customize package.json
# Update name, description, author fields

# 3. Customize index.ts
# Replace "mylang" with your language name
# Implement extraction logic for your language

# 4. Install and build
npm install
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

## Customization Guide

### 1. Update Plugin Metadata

Edit `manifest` in `index.ts`:

```typescript
export const manifest = {
  name: "sdl-mcp-YOURLANG-plugin", // Change this
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "YOUR LANG adapter plugin", // Change this
  author: "Your Name", // Change this
  license: "MIT", // Change if needed
  adapters: [
    {
      extension: ".yourlang", // Change this
      languageId: "yourlang", // Change this
    },
  ],
};
```

### 2. Update Adapter Class

Edit `MyLangAdapter` in `index.ts`:

```typescript
class YourLangAdapter extends BaseAdapter {
  languageId = "yourlang" as const; // Change this
  fileExtensions = [".yourlang"] as const; // Change this

  // Implement extraction methods for your language
}
```

### 3. Implement Extraction Logic

Replace the placeholder extraction methods with your language-specific logic:

#### For Simple Languages (Regex-based)

```typescript
extractSymbols(_tree: any, content: string, filePath: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  const lines = content.split("\n");

  lines.forEach((line, index) => {
    // Match function definitions
    const funcMatch = line.match(/YOUR_REGEX_HERE/);
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
```

#### For Complex Languages (Tree-sitter-based)

```typescript
import { getParser } from "sdl-mcp/dist/indexer/treesitter/grammarLoader.js";

class YourLangAdapter extends BaseAdapter {
  languageId = "yourlang" as const;
  fileExtensions = [".yourlang"] as const;

  extractSymbols(
    tree: any,
    content: string,
    filePath: string,
  ): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];

    if (!tree) {
      return symbols;
    }

    const parser = this.getParser();
    if (!parser) {
      return symbols;
    }

    const language = parser.getLanguage();

    try {
      const query = language.query(`
        (function_declaration name: (identifier) @name)
        (class_declaration name: (identifier) @name)
      `);

      const captures = query.captures(tree.rootNode);

      for (const [node, name] of captures) {
        if (name === "name") {
          symbols.push({
            id: `${filePath}:${node.text}`,
            name: node.text,
            kind:
              node.parent?.type === "function_declaration"
                ? "function"
                : "class",
            filePath,
            range: this.extractRange(node),
            parentId: null,
            metadata: {},
          });
        }
      }
    } catch (error) {
      console.error(`Query error in ${filePath}:`, error);
    }

    return symbols;
  }
}
```

### 4. Update package.json

```json
{
  "name": "sdl-mcp-yourlang-plugin",
  "version": "1.0.0",
  "description": "YourLang adapter plugin for SDL-MCP",
  "author": "Your Name <your.email@example.com>",
  "keywords": ["sdl-mcp", "plugin", "adapter", "yourlang"]
}
```

## File Structure

```text
my-lang-plugin/
|-- package.json          # NPM package metadata
|-- tsconfig.json         # TypeScript configuration
|-- index.ts              # Plugin implementation
|-- README.md             # Plugin documentation (this file)
|-- LICENSE               # License file
`-- dist/                 # Compiled output (generated)
    |-- index.js
    |-- index.d.ts
    `-- index.js.map
```

## Testing

Create test files with your language's extension:

```yourlang
// test.mylang
import "stdlib"

function greet(name: string) {
  print("Hello, " + name + "!");
}

class Calculator {
  function add(a: number, b: number): number {
    return a + b;
  }
}

function main() {
  greet("World");
  let calc = Calculator();
  calc.add(5, 3);
}
```

Run SDL-MCP indexing:

```bash
sdl-mcp index
```

Check logs for:

```
Plugin loaded successfully: your-lang-plugin@1.0.0
Indexed test.mylang: 3 symbols, 1 imports, 3 calls
```

## Publishing

### Publish to NPM

```bash
# 1. Login to NPM
npm login

# 2. Build plugin
npm run build

# 3. Publish
npm publish --access public

# 4. Verify
npm view sdl-mcp-yourlang-plugin
```

### Publish to Private Registry

```bash
# 1. Configure registry
npm config set registry https://npm.yourcompany.com

# 2. Publish
npm publish

# 3. Users install from your registry
npm install --registry https://npm.yourcompany.com sdl-mcp-yourlang-plugin
```

## Documentation

For more detailed information:

- [Plugin SDK Author Guide](../../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
- [Plugin SDK Security](../../docs/PLUGIN_SDK_SECURITY.md)
- [Example Plugin](../../examples/example-plugin/README.md)
- [SDL-MCP README](../../README.md)

## Support

For issues or questions:

- Check the [troubleshooting guide](../../docs/PLUGIN_SDK_AUTHOR_GUIDE.md#troubleshooting)
- Review the [Example Plugin](../../examples/example-plugin/README.md)
- Open an issue on the SDL-MCP repository

## License

MIT

## Contributing

Contributions are welcome! Please:

1. Fork this template
2. Customize for your language
3. Add tests
4. Submit a pull request

