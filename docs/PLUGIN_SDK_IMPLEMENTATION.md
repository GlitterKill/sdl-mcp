# Plugin SDK Implementation

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

## Overview

Successfully implemented a plugin system for SDL-MCP that allows runtime registration of language adapters without modifying the core codebase.

## Acceptance Criteria Status

✅ **AC1: Plugin can register language/extension without editing core adapters list**

- Plugins can be loaded via config file paths
- No modifications to `adapters.ts` or core adapter list required
- Registry now tracks both built-in and plugin adapters

✅ **AC2: Loader validates API version compatibility and reports actionable errors**

- Semantic versioning validates major version matches
- Clear error messages for incompatible versions
- Detailed validation results with errors and warnings
- Actionable error details logged for each failed load

✅ **AC3: Existing built-in adapters remain functional**

- Built-in adapters loaded separately from plugins
- Registry handles both sources transparently
- Backward compatibility maintained
- All existing tests pass

✅ **AC4: Unit tests validate registration, loading, and failure scenarios**

- Comprehensive test suite created:
  - `plugin-types.test.ts`: Tests validation logic
  - `plugin-loader.test.ts`: Tests loading and lifecycle
  - `plugin-registry.test.ts`: Tests registry integration
- Covers success paths, error paths, edge cases

## Implementation Details

### 1. Plugin Contract/Types (`src/indexer/adapter/plugin/types.ts`)

**Key Components:**

- **PluginManifestSchema**: Zod schema defining required plugin metadata
  - `name`: Plugin identifier
  - `version`: Plugin semantic version
  - `apiVersion`: Host API version compatibility
  - `adapters`: Array of file extension/language ID mappings
  - Optional: `description`, `author`, `license`

- **AdapterPlugin Interface**: Contract plugins must implement
  - `manifest`: Plugin metadata object
  - `createAdapters()`: Returns array of plugin adapter descriptors

- **Version Validation**:
  - `validateApiVersion()`: Checks major version compatibility
  - `validateManifest()`: Full manifest validation with schema and version checking
  - Returns structured validation results with errors/warnings

**API Versioning:**

- Current host API version: `1.0.0`
- Major version must match (e.g., plugin 1.x works with host 1.x)
- Minor/patch versions can differ

### 2. Runtime Loader (`src/indexer/adapter/plugin/loader.ts`)

**Core Functions:**

- **loadPlugin(pluginPath)**: Load single plugin from file
  - Validates file existence
  - Imports plugin module
  - Validates manifest
  - Registers plugin instance
  - Returns detailed load result with errors

- **loadPluginsFromConfig(paths)**: Load multiple plugins
  - Processes array of plugin paths
  - Returns separate success/failure lists
  - Logs summary of loaded/failed plugins

- **getPluginAdapters(plugin)**: Extract adapters from loaded plugin
  - Validates adapter structure
  - Ensures factory function exists
  - Returns typed adapter descriptors

**Lifecycle Management:**

- `getLoadedPlugins()`: List all currently loaded plugins
- `isPluginLoaded(path)`: Check if plugin is active
- `unloadPlugin(path)`: Remove plugin from registry
- `clearLoadedPlugins()`: Remove all plugins

**Error Handling:**

- Actionable error messages for each failure mode
- Detailed logging with plugin metadata
- Safe error boundaries prevent crashes
- Type-safe error propagation

### 3. Config Integration (`src/config/types.ts`)

**New Configuration Schema:**

```typescript
export const PluginConfigSchema = z.object({
  paths: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  strictVersioning: z.boolean().default(true),
});
```

**Usage in AppConfig:**

```json
{
  "repos": [...],
  "dbPath": "./data/sdlmcp.sqlite",
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  },
  "plugins": {
    "paths": ["/path/to/plugin1.js", "/path/to/plugin2.mjs"],
    "enabled": true,
    "strictVersioning": true
  }
}
```

### 4. Registry Integration (`src/indexer/adapter/registry.ts`)

**Enhancements:**

- **AdapterEntry Tracking**:
  - Added `source: "builtin" | "plugin"` field
  - Added `pluginName?: string` for plugin identity
  - Maintains backward compatibility with built-in adapters

- **Plugin Loading**:
  - `loadPlugins(paths)`: Load plugins from config
  - Registers plugin adapters in registry
  - Logs warnings when plugins override built-ins
  - Handles registration failures gracefully

- **Adapter Info**:
  - `getAdapterInfo(extension)`: Returns source and plugin metadata
  - Useful for debugging and introspection

- **Manual Registration**:
  - `registerAdapter()` now accepts source parameter
  - Allows plugin adapters to be registered programmatically

## Example Plugin (`examples/example-plugin/`)

**Purpose:** Demonstrates plugin development patterns

**Features:**

- Simple regex-based extraction for demonstration
- Extends BaseAdapter for common functionality
- Implements all required methods
- Full manifest with metadata
- Comprehensive README with development guide

**Structure:**

```
examples/example-plugin/
├── index.ts          # Plugin implementation
├── package.json       # Plugin metadata
└── README.md          # Development guide
```

## Testing Coverage

### Plugin Types Tests (`tests/unit/plugin-types.test.ts`)

- ✅ API version validation (matching major, mismatching major)
- ✅ Manifest validation (valid, missing fields, invalid API version)
- ✅ Optional fields support
- ✅ Adapter array validation

### Plugin Loader Tests (`tests/unit/plugin-loader.test.ts`)

- ✅ Loading valid plugin from file
- ✅ Loading non-existent plugin
- ✅ Loading plugin with invalid manifest
- ✅ Loading plugin with incompatible API version
- ✅ Loading multiple plugins
- ✅ Mixed success/failure handling
- ✅ Adapter creation and validation
- ✅ Plugin lifecycle management (load, unload, clear)
- ✅ Host API version reporting

### Plugin Registry Tests (`tests/unit/plugin-registry.test.ts`)

- ✅ Plugin adapter registration
- ✅ Multiple adapters from single plugin
- ✅ Plugin overriding built-in adapters
- ✅ Adapter info retrieval (source, plugin name)
- ✅ Language ID retrieval for plugin adapters
- ✅ Supported extensions including plugins
- ✅ Mixed built-in + plugin extensions
- ✅ Manual registration with source tracking

## Configuration Guide

### Quick Start

1. **Create plugin:**

   ```bash
   mkdir my-plugin
   cd my-plugin
   npm init -y
   ```

2. **Implement plugin:**

   ```typescript
   import { AdapterPlugin } from "sdl-mcp/dist/indexer/adapter/plugin/types.js";
   import { BaseAdapter } from "sdl-mcp/dist/indexer/adapter/BaseAdapter.js";

   export const manifest = {
     name: "my-plugin",
     version: "1.0.0",
     apiVersion: "1.0.0",
     adapters: [{ extension: ".mylang", languageId: "mylang" }],
   };

   class MyAdapter extends BaseAdapter {
     languageId = "mylang" as const;
     fileExtensions = [".mylang"] as const;
     // Implement required methods...
   }

   export async function createAdapters() {
     return [
       {
         extension: ".mylang",
         languageId: "mylang",
         factory: () => new MyAdapter(),
       },
     ];
   }
   ```

3. **Build plugin:**

   ```bash
   npm install
   npm run build
   ```

4. **Register plugin:**

   ```json
   {
     "plugins": {
       "paths": ["./my-plugin/dist/index.js"],
       "enabled": true
     }
   }
   ```

5. **Index with plugin:**
   ```bash
   sdl-mcp index
   ```

## Build Status

✅ All new plugin files compile successfully
✅ Type checking passes for new files
✅ Existing built-in adapters remain functional
✅ Example plugin demonstrates complete implementation

## Files Created/Modified

### New Files:

- `src/indexer/adapter/plugin/types.ts` (157 lines)
- `src/indexer/adapter/plugin/loader.ts` (183 lines)
- `src/indexer/adapter/plugin/index.ts` (3 lines)
- `tests/unit/plugin-types.test.ts` (125 lines)
- `tests/unit/plugin-loader.test.ts` (414 lines)
- `tests/unit/plugin-registry.test.ts` (308 lines)
- `examples/example-plugin/index.ts` (115 lines)
- `examples/example-plugin/README.md` (232 lines)
- `examples/example-plugin/package.json` (27 lines)

### Modified Files:

- `src/config/types.ts` (+16 lines)
- `src/indexer/adapter/registry.ts` (+73 lines)

## Backward Compatibility

✅ Existing `adapters.ts` remains unchanged
✅ Built-in adapter loading works as before
✅ Existing tests pass
✅ No breaking changes to public API

## Next Steps (Optional Enhancements)

1. **Plugin Distribution**: NPM registry for sharing plugins
2. **Hot Reloading**: Reload plugins without restart
3. **Plugin Discovery**: Auto-discover plugins in directories
4. **Dependency Management**: Plugin interdependencies
5. **Plugin Marketplace**: Central repository for plugins
6. **Documentation Site**: Dedicated plugin development docs

## Notes

- Plugin loader is designed for safety with extensive error handling
- Version checking is strict by default (major version must match)
- Plugins can override built-in adapters with warning logged
- Registry maintains source tracking for debugging
- All errors include actionable information for troubleshooting
