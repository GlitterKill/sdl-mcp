import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

import {
  loadPlugin,
  loadPluginsFromConfig,
  getPluginAdapters,
  getLoadedPlugins,
  isPluginLoaded,
  unloadPlugin,
  clearLoadedPlugins,
  getHostApiVersion,
} from "../../dist/indexer/adapter/plugin/loader.js";
import type { LanguageAdapter } from "../../dist/indexer/adapter/LanguageAdapter.js";

const TEST_PLUGINS_DIR = path.join(process.cwd(), "test-plugins");

describe("Plugin Loader", () => {
  beforeEach(() => {
    clearLoadedPlugins();
    if (existsSync(TEST_PLUGINS_DIR)) {
      rmSync(TEST_PLUGINS_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
  });

  describe("loadPlugin", () => {
    it("should load a valid plugin", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "valid-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "valid-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".test", languageId: "test-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".test",
              languageId: "test-lang",
              factory: () => ({
                languageId: "test-lang",
                fileExtensions: [".test"],
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

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, true);
      assert.strictEqual(result.plugin.manifest.name, "valid-plugin");
      assert.strictEqual(result.errors.length, 0);
      assert.ok(isPluginLoaded(pluginPath));
    });

    it("should fail to load non-existent plugin", async () => {
      const result = await loadPlugin("nonexistent-plugin.mjs");

      assert.strictEqual(result.loaded, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes("not found"));
    });

    it("should fail to load plugin with invalid manifest", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "invalid-manifest.mjs");
      const pluginContent = `
        export const manifest = {
          name: "invalid-plugin"
        };

        export async function createAdapters() {
          return [];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, false);
      assert.ok(result.errors.length > 0);
    });

    it("should fail to load plugin with incompatible API version", async () => {
      const pluginPath = path.join(
        TEST_PLUGINS_DIR,
        "incompatible-version.mjs",
      );
      const pluginContent = `
        export const manifest = {
          name: "incompatible-plugin",
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

    it("should fail to load plugin with invalid module structure", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "invalid-structure.mjs");
      const pluginContent = `
        export const something = "value";
      `;
      writeFileSync(pluginPath, pluginContent);

      const result = await loadPlugin(pluginPath);

      assert.strictEqual(result.loaded, false);
      assert.ok(result.errors.some((e) => e.includes("manifest")));
    });
  });

  describe("loadPluginsFromConfig", () => {
    it("should load multiple plugins successfully", async () => {
      const plugin1Path = path.join(TEST_PLUGINS_DIR, "plugin1.mjs");
      const plugin2Path = path.join(TEST_PLUGINS_DIR, "plugin2.mjs");

      for (const [name, index] of [
        ["plugin1", 1],
        ["plugin2", 2],
      ]) {
        const pluginPath = path.join(TEST_PLUGINS_DIR, `${name}.mjs`);
        const pluginContent = `
          export const manifest = {
            name: "${name}",
            version: "1.0.0",
            apiVersion: "${getHostApiVersion()}",
            adapters: [
              { extension: ".test${index}", languageId: "test-lang${index}" }
            ]
          };

          export async function createAdapters() {
            return [
              {
                extension: ".test${index}",
                languageId: "test-lang${index}",
                factory: () => ({
                  languageId: "test-lang${index}",
                  fileExtensions: [".test${index}"],
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
      }

      const result = await loadPluginsFromConfig([plugin1Path, plugin2Path]);

      assert.strictEqual(result.successful.length, 2);
      assert.strictEqual(result.failed.length, 0);
      assert.strictEqual(getLoadedPlugins().length, 2);
    });

    it("should handle mixed success and failure", async () => {
      const validPluginPath = path.join(TEST_PLUGINS_DIR, "valid.mjs");
      const invalidPluginPath = path.join(TEST_PLUGINS_DIR, "invalid.mjs");

      const validPluginContent = `
        export const manifest = {
          name: "valid-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: []
        };

        export async function createAdapters() {
          return [];
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(validPluginPath, validPluginContent);

      const result = await loadPluginsFromConfig([
        validPluginPath,
        invalidPluginPath,
      ]);

      assert.strictEqual(result.successful.length, 1);
      assert.strictEqual(result.failed.length, 1);
      assert.ok(result.failed[0].pluginPath.includes("invalid.mjs"));
    });

    it("should return empty result when no plugin paths provided", async () => {
      const result = await loadPluginsFromConfig(undefined);

      assert.strictEqual(result.successful.length, 0);
      assert.strictEqual(result.failed.length, 0);
    });

    it("should return empty result when empty array provided", async () => {
      const result = await loadPluginsFromConfig([]);

      assert.strictEqual(result.successful.length, 0);
      assert.strictEqual(result.failed.length, 0);
    });
  });

  describe("getPluginAdapters", () => {
    it("should return valid adapters from plugin", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "adapters-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "adapters-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".test1", languageId: "test-lang1" },
            { extension: ".test2", languageId: "test-lang2" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".test1",
              languageId: "test-lang1",
              factory: () => ({
                languageId: "test-lang1",
                fileExtensions: [".test1"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            },
            {
              extension: ".test2",
              languageId: "test-lang2",
              factory: () => ({
                languageId: "test-lang2",
                fileExtensions: [".test2"],
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
      assert.strictEqual(adapters[0].extension, ".test1");
      assert.strictEqual(adapters[1].extension, ".test2");
    });

    it("should throw error for invalid adapter structure", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "invalid-adapter.mjs");
      const pluginContent = `
        export const manifest = {
          name: "invalid-adapter-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: []
        };

        export async function createAdapters() {
          return [
            {
              extension: ".test",
            }
          ];
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

    it("should throw error if createAdapters returns non-array", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "non-array-adapter.mjs");
      const pluginContent = `
        export const manifest = {
          name: "non-array-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: []
        };

        export async function createAdapters() {
          return "not an array";
        }

        export default { manifest, createAdapters };
      `;
      writeFileSync(pluginPath, pluginContent);

      const loadResult = await loadPlugin(pluginPath);
      assert.ok(loadResult.loaded);

      await assert.rejects(async () => {
        await getPluginAdapters(loadResult.plugin);
      }, /must return an array/);
    });
  });

  describe("plugin lifecycle management", () => {
    it("should track loaded plugins", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "track-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "track-plugin",
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

      assert.strictEqual(isPluginLoaded(pluginPath), false);

      await loadPlugin(pluginPath);
      assert.strictEqual(isPluginLoaded(pluginPath), true);

      const loaded = getLoadedPlugins();
      assert.ok(loaded.some((p) => p.manifest.name === "track-plugin"));
    });

    it("should unload plugin", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "unload-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "unload-plugin",
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

      await loadPlugin(pluginPath);
      assert.strictEqual(isPluginLoaded(pluginPath), true);

      const unloaded = unloadPlugin(pluginPath);
      assert.strictEqual(unloaded, true);
      assert.strictEqual(isPluginLoaded(pluginPath), false);
    });

    it("should return false when unloading non-existent plugin", () => {
      const result = unloadPlugin("nonexistent-plugin.mjs");
      assert.strictEqual(result, false);
    });

    it("should clear all loaded plugins", async () => {
      const plugin1Path = path.join(TEST_PLUGINS_DIR, "clear1.mjs");
      const plugin2Path = path.join(TEST_PLUGINS_DIR, "clear2.mjs");

      for (let i = 1; i <= 2; i++) {
        const pluginPath = path.join(TEST_PLUGINS_DIR, `clear${i}.mjs`);
        const pluginContent = `
          export const manifest = {
            name: "clear${i}",
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
      }

      await loadPluginsFromConfig([plugin1Path, plugin2Path]);
      assert.strictEqual(getLoadedPlugins().length, 2);

      clearLoadedPlugins();
      assert.strictEqual(getLoadedPlugins().length, 0);
    });
  });

  describe("getHostApiVersion", () => {
    it("should return a valid version string", () => {
      const version = getHostApiVersion();
      assert.ok(typeof version === "string");
      assert.ok(version.match(/^\d+\.\d+\.\d+$/));
    });
  });
});
