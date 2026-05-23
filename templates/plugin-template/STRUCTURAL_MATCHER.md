# Optional Structural Matcher

Use this guide only for tree-sitter-backed adapters. Regex-only adapters should not expose a structural matcher because SDL-MCP needs a real syntax tree to avoid comments, strings, and broad expression nodes.

A structural matcher enables AST-aware `search.edit` for a plugin language:

- `targeting: "identifier"` replaces exact identifier nodes listed in `identifierNodeTypes`.
- `targeting: "structural"` runs a bounded grammar-native tree-sitter query and replaces the selected capture.

## Adapter Descriptor

```typescript
import Parser from "tree-sitter";
import type { StructuralMatcherDescriptor } from "sdl-mcp/dist/indexer/adapter/LanguageAdapter.js";
import type { PluginAdapter } from "sdl-mcp/dist/indexer/adapter/plugin/types.js";
import YourLangGrammar from "tree-sitter-yourlang";

const language = YourLangGrammar as Parser.Language;

const structuralMatcher = {
  identifierNodeTypes: ["identifier"],
  createQuery(queryString: string): Parser.Query {
    return new Parser.Query(language, queryString);
  },
} satisfies StructuralMatcherDescriptor;

export async function createAdapters(): Promise<PluginAdapter[]> {
  return [
    {
      extension: ".yourlang",
      languageId: "yourlang",
      factory: () => new YourLangAdapter(),
      structuralMatcher,
    },
  ];
}
```

## Choosing Identifier Nodes

Keep `identifierNodeTypes` conservative. Include only node types whose complete node text is safe to replace as an identifier. Do not include comments, strings, literals, broad expressions, blocks, or declarations whose text includes more than the identifier.

Good candidates are usually named nodes such as `identifier`, `simple_identifier`, `name`, or grammar-specific field identifier nodes. Confirm them with small fixtures and parser output before publishing.

## Tests To Add

Add focused tests before enabling the descriptor:

- exact identifier replacement skips comments and strings
- structural query replacement edits only the selected capture
- invalid tree-sitter query syntax throws a clear validation error
- malformed source files return no AST-aware edits instead of throwing
- plugin registration exposes the matcher for the configured extension
