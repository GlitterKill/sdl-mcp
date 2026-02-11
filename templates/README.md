# SDL-MCP Plugin Templates

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../README.md)
- [Documentation Hub](../docs/README.md)
  - [Getting Started](../docs/getting-started.md)
  - [Plugin SDK Author Guide](../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
  - [Plugin SDK Security](../docs/PLUGIN_SDK_SECURITY.md)
- [Templates (this page)](./README.md)
- [Plugin Template README](./plugin-template/README.md)

</details>
</div>

Templates and scaffolding for creating SDL-MCP adapter plugins.

## Available Templates

### plugin-template

A complete template for creating a new language adapter plugin.

**Features**:

- Pre-configured TypeScript setup
- Base adapter implementation
- Sample extraction logic (regex-based)
- Test suite template
- Package.json configuration
- Comprehensive README

**Use when**:

- Creating a new language adapter
- Need a starting point for custom adapters
- Want to follow SDL-MCP plugin conventions

**Quick Start**:

```bash
# Copy template
cp -r templates/plugin-template my-lang-plugin
cd my-lang-plugin

# Customize and build
npm install
npm run build

# Register in SDL-MCP
# Add to config/sdlmcp.config.json:
{
  "plugins": {
    "paths": ["./my-lang-plugin/dist/index.js"]
  }
}
```

See [plugin-template/README.md](./plugin-template/README.md) for detailed instructions.

## Template Structure

```text
templates/
|-- plugin-template/        # Full plugin template
|   |-- package.json        # NPM configuration
|   |-- tsconfig.json       # TypeScript configuration
|   |-- index.ts            # Plugin implementation
|   |-- README.md           # Plugin documentation
|   |-- LICENSE             # MIT license
|   `-- test/               # Test suite
|       `-- plugin.test.ts
`-- README.md               # This file
```

## Using Templates

### 1. Copy Template

```bash
# From SDL-MCP repository
cp -r templates/plugin-template my-plugin
cd my-plugin
```

### 2. Customize

Edit the following files:

- `package.json`: Update name, description, author
- `index.ts`: Replace placeholder code with your adapter
- `README.md`: Update documentation for your language
- `test/plugin.test.ts`: Add language-specific tests

### 3. Build

```bash
npm install
npm run build
```

### 4. Test

```bash
npm test
```

### 5. Publish (optional)

```bash
npm publish
```

## Customization Guide

### Minimal Changes Required

1. **Update plugin metadata** in `index.ts`:

   ```typescript
   export const manifest = {
     name: "sdl-mcp-YOURLANG-plugin",
     adapters: [
       {
         extension: ".yourlang",
         languageId: "yourlang",
       },
     ],
   };
   ```

2. **Update adapter class** in `index.ts`:

   ```typescript
   class YourLangAdapter extends BaseAdapter {
     languageId = "yourlang" as const;
     fileExtensions = [".yourlang"] as const;
   }
   ```

3. **Implement extraction logic**:
   - Replace regex patterns in `extractSymbols()`
   - Replace regex patterns in `extractImports()`
   - Replace regex patterns in `extractCalls()`

### Advanced Customization

For complex languages, consider:

1. **Use Tree-sitter grammars**:

   ```typescript
   const parser = this.getParser();
   const query = parser.getLanguage().query(`
     (function_declaration name: (_) @name)
   `);
   ```

2. **Add language-specific metadata**:

   ```typescript
   metadata: {
     visibility: "public",
     async: false,
     params: [...],
     returns: "string",
   }
   ```

3. **Handle language-specific features**:
   - Generics/templates
   - Decorators/attributes
   - Macros/preprocessor directives
   - Custom syntax

## Template vs Example

| Feature       | Template                       | Example                        |
| ------------- | ------------------------------ | ------------------------------ |
| Purpose       | Starting point for new plugins | Demonstration of plugin system |
| Complexity    | Minimal, easy to customize     | Functional, production-ready   |
| Documentation | Inline comments, guide         | Comprehensive README           |
| Tests         | Template test suite            | Integration tests              |
| Language      | Placeholder (mylang)           | Hypothetical (example-lang)    |

**Use the template** when creating your own plugin.

**Use the example** when learning the plugin system.

## Next Steps

After using a template:

1. **Read the author guide**: [PLUGIN_SDK_AUTHOR_GUIDE.md](../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
2. **Review security docs**: [PLUGIN_SDK_SECURITY.md](../docs/PLUGIN_SDK_SECURITY.md)
3. **Study the example**: [examples/example-plugin/](../examples/example-plugin/)
4. **Run integration tests**: `npm run test:integration`

## Support

For help with templates:

- Check the [Author Guide](../docs/PLUGIN_SDK_AUTHOR_GUIDE.md)
- Review the [Example Plugin](../examples/example-plugin/)
- Check [Troubleshooting](../docs/PLUGIN_SDK_AUTHOR_GUIDE.md#troubleshooting)
- Open an issue on GitHub

## Contributing

Have suggestions for improving templates? Contributions welcome:

1. Fork the repository
2. Improve the template
3. Add tests for new features
4. Submit a pull request

## License

All templates are licensed under MIT.

## See Also

- [SDL-MCP README](../README.md)
- [Plugin SDK Implementation Summary](../docs/PLUGIN_SDK_IMPLEMENTATION.md)
- [Example Plugin](../examples/example-plugin/)

