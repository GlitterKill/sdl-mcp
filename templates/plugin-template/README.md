# MyLang SDL-MCP Adapter Plugin Template

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Plugin SDK Author Guide](../../docs/plugin-sdk-author-guide.md)
  - [Plugin SDK Quick Reference](../../docs/plugin-sdk-quick-reference.md)
  - [Plugin SDK Security](../../docs/plugin-sdk-security.md)
- [Example Plugin](../../examples/example-plugin/README.md)
- [Plugin Template (this page)](./README.md)

</details>
</div>

This template is a starting point for an SDL-MCP adapter plugin. It ships a small `.mylang` adapter, TypeScript package metadata, and `node:test` coverage that you can replace with extraction logic for another language.

Use this template when a language is not covered by SDL-MCP's built-in adapters. Built-in adapters remain the better choice for supported languages because they receive core test coverage and pass-2 resolution improvements.

## Quick Start

Copy the template from a source checkout, then install dependencies before building. The template depends on `sdl-mcp` for SDK types, so `npm install` must run before `npm run build`.

```powershell
# From the SDL-MCP repository root
Copy-Item -Recurse .\templates\plugin-template ..\my-lang-plugin
Set-Location ..\my-lang-plugin
npm install
npm run build
npm test
```

If you are developing against an unpublished local SDL-MCP checkout, replace the template's `devDependencies.sdl-mcp` value with a local file reference before installing.

```json
{
  "devDependencies": {
    "sdl-mcp": "file:../sdl-mcp"
  }
}
```

Register the compiled plugin entrypoint in your SDL-MCP config.

```json
{
  "plugins": {
    "paths": ["C:/path/to/my-lang-plugin/dist/index.js"],
    "enabled": true,
    "strictVersioning": true
  }
}
```

## What To Customize

Start with names and package metadata. Update `package.json`, `manifest`, `languageId`, `fileExtensions`, class names, test names, and every `.mylang` example so they describe one real language.

```typescript
export const manifest = {
  name: "sdl-mcp-yourlang-plugin",
  version: "1.0.0",
  apiVersion: "1.0.0",
  description: "YourLang adapter plugin for SDL-MCP",
  author: "Your Name",
  license: "MIT",
  adapters: [
    {
      extension: ".yourlang",
      languageId: "yourlang",
    },
  ],
};
```

Keep `manifest.adapters` and `createAdapters()` in sync. SDL-MCP validates both surfaces during plugin loading, then registers each adapter descriptor by file extension.

```typescript
export async function createAdapters() {
  return [
    {
      extension: ".yourlang",
      languageId: "yourlang",
      factory: () => new YourLangAdapter(),
    },
  ];
}
```

## Required Exports

Every plugin must export:

1. `manifest`: plugin metadata and adapter declarations.
2. `createAdapters()`: a function that returns adapter descriptors.
3. A default export containing `manifest` and `createAdapters`.

The template also exports `MyLangAdapter` so the bundled unit tests can instantiate it directly. SDL-MCP does not require that class export at runtime, but keeping it exported makes plugin tests simpler.

## Extraction Contract

An adapter provides three extraction hooks:

| Method | Purpose |
| ------ | ------- |
| `extractSymbols()` | Return functions, classes, methods, types, or other indexable symbols. |
| `extractImports()` | Return module or file references from import-like syntax. |
| `extractCalls()` | Return calls that can be resolved to extracted symbols. |

Each hook must return an array and should handle malformed input without throwing. Symbols need stable `nodeId` values, imports need `specifier` metadata, and calls should set `calleeIdentifier` plus `calleeSymbolId` when they resolve locally. Report ranges with 1-based line numbers and 0-based columns.

## Regex-Based Adapters

The template starts with simple regex extraction. This works for line-oriented languages and for early prototypes where approximate symbols are better than no symbols.

Regex-only adapters do not have a tree-sitter grammar. The template overrides `parse()` with a small tree-shaped placeholder so SDL-MCP still calls the extraction hooks during indexing. Keep that override when you do not provide a parser.

```typescript
export class YourLangAdapter extends BaseAdapter {
  languageId = "yourlang" as const;
  fileExtensions = [".yourlang"] as const;

  getParser(): null {
    return null;
  }

  parse(
    _content: string,
    _filePath: string,
  ): NonNullable<ReturnType<LanguageAdapter["parse"]>> {
    return REGEX_PARSE_TREE;
  }

  extractSymbols(_tree: unknown, content: string, filePath: string) {
    // Replace this with your language-specific extraction logic.
    return [];
  }
}
```

Regex extraction is intentionally limited. It is a good bootstrap path, but it cannot provide compiler-grade resolution, nested syntax awareness, or robust handling of comments and strings.

## Tree-Sitter Adapters

Use tree-sitter when syntax shape matters. Tree-sitter adapters should load a grammar, return a real tree from `parse()`, and use `Parser.Query` or AST traversal in the extraction hooks.

```typescript
import Parser, { type Tree } from "tree-sitter";
import YourLangGrammar from "tree-sitter-yourlang";

const language = YourLangGrammar as Parser.Language;
const parser = new Parser();
parser.setLanguage(language);

export class YourLangAdapter extends BaseAdapter {
  languageId = "yourlang" as const;
  fileExtensions = [".yourlang"] as const;

  getParser(): Parser {
    return parser;
  }

  parse(content: string): Tree | null {
    return parser.parse(content);
  }

  extractSymbols(tree: Tree, _content: string, filePath: string) {
    const symbols: ExtractedSymbol[] = [];
    const query = new Parser.Query(language, `
      (function_declaration name: (identifier) @name)
    `);

    for (const capture of query.captures(tree.rootNode)) {
      if (capture.name !== "name") continue;
      const node = capture.node;
      symbols.push({
        nodeId: `${filePath}:function:${node.text}:${node.startPosition.row + 1}`,
        name: node.text,
        kind: "function",
        exported: false,
        range: this.extractRange(node),
      });
    }

    return symbols;
  }
}
```

If your language needs exact cross-file references, prefer a compiler-backed SCIP indexer or adapter-specific `resolveCall()` support over expanding regex patterns. Regex improvements can improve recall, but they do not become semantic resolution.

## File Structure

```text
my-lang-plugin/
|-- package.json          # npm package metadata, scripts, peer dependency
|-- tsconfig.json         # TypeScript configuration
|-- index.ts              # Plugin manifest and adapter implementation
|-- README.md             # Plugin documentation
|-- LICENSE               # License text
|-- test/
|   `-- plugin.test.ts    # node:test coverage for extraction behavior
`-- dist/                 # Compiled output generated by npm run build
    |-- index.js
    |-- index.d.ts
    |-- index.js.map
    `-- test/
        `-- plugin.test.js
```

## Testing

The template test script builds first, then runs the compiled tests.

```bash
npm test
```

Add tests for every syntax form your plugin claims to support:

- Symbol declarations, including nested or exported declarations.
- Import forms and edge cases such as aliases or relative paths.
- Call forms that should resolve to symbols.
- Empty files, comments, malformed files, and unsupported constructs.

Use small fixture strings for unit tests, then run an SDL-MCP indexing pass against real fixture files before publishing.

```bash
sdl-mcp index --config ./sdlmcp.config.json
```

With debug logging enabled, check that the plugin loads and that files with your extension produce symbols.

```powershell
$env:SDL_LOG_LEVEL = "debug"
sdl-mcp index --config .\sdlmcp.config.json
```

## Package Metadata

The template includes `files` so published packages contain only runtime artifacts and documentation.

```json
{
  "files": ["dist", "README.md", "LICENSE"]
}
```

Before publishing, narrow the `peerDependencies.sdl-mcp` range to the host versions you test against. Leaving it as `*` is convenient for a template, but it is too permissive for a production plugin.

```json
{
  "peerDependencies": {
    "sdl-mcp": "^0.11.0"
  }
}
```

## Security

SDL-MCP plugins execute inside the SDL-MCP process. Treat every plugin as trusted code with the same filesystem, environment, network, and process permissions as the host.

Before installing or publishing a plugin:

- Review all runtime dependencies.
- Avoid `eval`, dynamic imports from user input, and shell execution with interpolated strings.
- Validate file paths and untrusted input.
- Add resource guards around expensive parsing or traversal.
- Test with `strictVersioning: true`.

See [Plugin SDK Security](../../docs/plugin-sdk-security.md) for the full threat model.

## Further Reading

- [Plugin SDK Author Guide](../../docs/plugin-sdk-author-guide.md)
- [Plugin SDK Quick Reference](../../docs/plugin-sdk-quick-reference.md)
- [Plugin SDK Security](../../docs/plugin-sdk-security.md)
- [Example Plugin](../../examples/example-plugin/README.md)
