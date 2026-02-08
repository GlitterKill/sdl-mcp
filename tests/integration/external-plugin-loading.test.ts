import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";

import {
  loadPlugin,
  loadPluginsFromConfig,
  getLoadedPlugins,
  clearLoadedPlugins,
  getHostApiVersion,
} from "../../dist/indexer/adapter/plugin/loader.js";
import {
  registerAdapter,
  getAdapter,
} from "../../dist/indexer/adapter/registry.js";
import { getPluginAdapters } from "../../dist/indexer/adapter/plugin/loader.js";

describe("External Plugin Loading Integration Tests (V06-10)", () => {
  const TEST_PLUGIN_DIR = path.join(process.cwd(), "test-external-plugins");
  const TEST_CONFIG_DIR = path.join(process.cwd(), "test-plugin-config");

  beforeEach(() => {
    clearLoadedPlugins();
    if (existsSync(TEST_PLUGIN_DIR)) {
      rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true });
    }
    if (existsSync(TEST_CONFIG_DIR)) {
      rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_PLUGIN_DIR, { recursive: true });
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    clearLoadedPlugins();
    if (existsSync(TEST_PLUGIN_DIR)) {
      rmSync(TEST_PLUGIN_DIR, { recursive: true, force: true });
    }
    if (existsSync(TEST_CONFIG_DIR)) {
      rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    }
  });

  describe("AC3: External Plugin Load Path Tests", () => {
    it("should load plugin from absolute path", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "absolute-path-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "absolute-path-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [{ extension: ".testabs", languageId: "test-abs-lang" }]
        };

        export async function createAdapters() {
          return [{
            extension: ".testabs",
            languageId: "test-abs-lang",
            factory: () => ({
              languageId: "test-abs-lang",
              fileExtensions: [".testabs"],
              getParser: () => null,
              parse: () => null,
              extractSymbols: () => [],
              extractImports: () => [],
              extractCalls: () => []
            })
          }];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, true);
      assert.strictEqual(result.plugin.manifest.name, "absolute-path-plugin");
      assert.strictEqual(getLoadedPlugins().length, 1);
    });

    it("should load plugin from relative path", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "relative-path-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "relative-path-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [{ extension: ".testrel", languageId: "test-rel-lang" }]
        };

        export async function createAdapters() {
          return [{
            extension: ".testrel",
            languageId: "test-rel-lang",
            factory: () => ({
              languageId: "test-rel-lang",
              fileExtensions: [".testrel"],
              getParser: () => null,
              parse: () => null,
              extractSymbols: () => [],
              extractImports: () => [],
              extractCalls: () => []
            })
          }];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(
        `./${path.relative(process.cwd(), pluginPath)}`,
      );

      assert.strictEqual(result.loaded, true);
      assert.strictEqual(result.plugin.manifest.name, "relative-path-plugin");
    });

    it("should load multiple plugins from config paths", async () => {
      const plugin1Path = path.join(TEST_PLUGIN_DIR, "multi-plugin-1.mjs");
      const plugin2Path = path.join(TEST_PLUGIN_DIR, "multi-plugin-2.mjs");

      for (let i = 1; i <= 2; i++) {
        const pluginPath = path.join(TEST_PLUGIN_DIR, `multi-plugin-${i}.mjs`);
        const pluginContent = `
          export const manifest = {
            name: "multi-plugin-${i}",
            version: "1.0.0",
            apiVersion: "${getHostApiVersion()}",
            adapters: [{ extension: ".multi${i}", languageId: "multi-lang-${i}" }]
          };

          export async function createAdapters() {
            return [{
              extension: ".multi${i}",
              languageId: "multi-lang-${i}",
              factory: () => ({
                languageId: "multi-lang-${i}",
                fileExtensions: [".multi${i}"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            }];
          }

          export default { manifest, createAdapters };
        `;
        writeFileSync(pluginPath, pluginContent);
      }

      const result = await loadPluginsFromConfig([plugin1Path, plugin2Path]);

      assert.strictEqual(result.successful.length, 2);
      assert.strictEqual(result.failed.length, 0);
      assert.strictEqual(getLoadedPlugins().length, 2);
      assert.ok(
        result.successful.some((p) => p.manifest.name === "multi-plugin-1"),
      );
      assert.ok(
        result.successful.some((p) => p.manifest.name === "multi-plugin-2"),
      );
    });

    it("should handle non-existent plugin paths gracefully", async () => {
      const result = await loadPluginsFromConfig([
        "non-existent-plugin.mjs",
        path.join(TEST_PLUGIN_DIR, "valid-plugin.mjs"),
      ]);

      assert.strictEqual(result.successful.length, 0);
      assert.strictEqual(result.failed.length, 2);
      assert.ok(result.failed[0].error.includes("not found"));
    });
  });

  describe("Plugin Registration in Adapter Registry", () => {
    it("should register plugin adapters in registry", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "registry-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "registry-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [{ extension: ".regtest", languageId: "reg-test-lang" }]
        };

        export async function createAdapters() {
          return [{
            extension: ".regtest",
            languageId: "reg-test-lang",
            factory: () => ({
              languageId: "reg-test-lang",
              fileExtensions: [".regtest"],
              getParser: () => null,
              parse: () => null,
              extractSymbols: () => [],
              extractImports: () => [],
              extractCalls: () => []
            })
          }];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const loadResult = await loadPlugin(pluginPath);
      assert.ok(loadResult.loaded);

      const adapters = await getPluginAdapters(loadResult.plugin);
      assert.strictEqual(adapters.length, 1);

      const adapter = adapters[0].factory();
      registerAdapter(".regtest", adapter, "plugin", "registry-plugin");

      const registered = getAdapter(".regtest");
      assert.ok(registered, "Adapter should be registered in registry");
      assert.strictEqual(registered.source, "plugin");
      assert.strictEqual(registered.pluginName, "registry-plugin");
    });

    it("should handle multiple adapters from single plugin", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "multi-adapter-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "multi-adapter-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".multia", languageId: "multi-a-lang" },
            { extension: ".multib", languageId: "multi-b-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".multia",
              languageId: "multi-a-lang",
              factory: () => ({
                languageId: "multi-a-lang",
                fileExtensions: [".multia"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            },
            {
              extension: ".multib",
              languageId: "multi-b-lang",
              factory: () => ({
                languageId: "multi-b-lang",
                fileExtensions: [".multib"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            }
          ];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const loadResult = await loadPlugin(pluginPath);
      assert.ok(loadResult.loaded);

      const adapters = await getPluginAdapters(loadResult.plugin);
      assert.strictEqual(adapters.length, 2);

      for (const adapterDesc of adapters) {
        const adapter = adapterDesc.factory();
        registerAdapter(
          adapterDesc.extension,
          adapter,
          "plugin",
          "multi-adapter-plugin",
        );

        const registered = getAdapter(adapterDesc.extension);
        assert.ok(
          registered,
          `Adapter for ${adapterDesc.extension} should be registered`,
        );
        assert.strictEqual(registered.source, "plugin");
      }
    });
  });

  describe("Plugin Lifecycle and Error Handling", () => {
    it("should fail gracefully on invalid plugin", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "invalid-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "invalid-plugin"
        };
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, false);
      assert.ok(result.errors.length > 0);
      assert.strictEqual(getLoadedPlugins().length, 0);
    });

    it("should handle incompatible API versions", async () => {
      const pluginPath = path.join(
        TEST_PLUGIN_DIR,
        "incompatible-version-plugin.mjs",
      );
      const pluginContent = `
        export const manifest = {
          name: "incompatible-version-plugin",
          version: "1.0.0",
          apiVersion: "99.0.0",
          adapters: []
        };

        export async function createAdapters() {
          return [];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, false);
      assert.ok(
        result.errors.some((e) => e.includes("Incompatible API version")),
      );
    });

    it("should handle plugin with invalid adapter structure", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "bad-adapter-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "bad-adapter-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: []
        };

        export async function createAdapters() {
          return [{ extension: ".bad" }];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const loadResult = await loadPlugin(pluginPath);
      assert.ok(loadResult.loaded);

      await assert.rejects(async () => {
        await getPluginAdapters(loadResult.plugin);
      }, /Invalid adapter/);
    });
  });

  describe("Config File Integration", () => {
    it("should load plugins from config file", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "config-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "config-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [{ extension: ".cfgtest", languageId: "cfg-test-lang" }]
        };

        export async function createAdapters() {
          return [{
            extension: ".cfgtest",
            languageId: "cfg-test-lang",
            factory: () => ({
              languageId: "cfg-test-lang",
              fileExtensions: [".cfgtest"],
              getParser: () => null,
              parse: () => null,
              extractSymbols: () => [],
              extractImports: () => [],
              extractCalls: () => []
            })
          }];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const configPath = path.join(TEST_CONFIG_DIR, "sdlmcp.config.json");
      const config = {
        plugins: {
          paths: [pluginPath],
          enabled: true,
          strictVersioning: true,
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      const configContent = JSON.parse(readFileSync(configPath, "utf-8"));
      const result = await loadPluginsFromConfig(configContent.plugins.paths);

      assert.strictEqual(result.successful.length, 1);
      assert.strictEqual(result.failed.length, 0);
      assert.strictEqual(result.successful[0].manifest.name, "config-plugin");
    });

    it("should handle disabled plugin configuration", async () => {
      const pluginPath = path.join(TEST_PLUGIN_DIR, "disabled-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "disabled-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: []
        };

        export async function createAdapters() {
          return [];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const config = {
        plugins: {
          paths: [pluginPath],
          enabled: false,
        },
      };

      const result = config.plugins.enabled
        ? await loadPluginsFromConfig(config.plugins.paths)
        : await loadPluginsFromConfig([]);

      assert.strictEqual(result.successful.length, 0);
    });
  });
});
