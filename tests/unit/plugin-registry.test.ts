import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

import {
  loadBuiltInAdapters,
  registerAdapter,
  getAdapterForExtension,
  getSupportedExtensions,
  getLanguageIdForExtension,
  loadPlugins,
  getAdapterInfo,
} from "../../dist/indexer/adapter/registry.js";
import { getHostApiVersion } from "../../dist/indexer/adapter/plugin/loader.js";

const TEST_PLUGINS_DIR = path.join(process.cwd(), "test-registry-plugins");

describe("Registry with Plugin Integration", () => {
  beforeEach(() => {
    if (existsSync(TEST_PLUGINS_DIR)) {
      rmSync(TEST_PLUGINS_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_PLUGINS_DIR)) {
      rmSync(TEST_PLUGINS_DIR, { recursive: true, force: true });
    }
  });

  describe("plugin registration", () => {
    it("should register plugin adapters", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "registry-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "registry-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".custom", languageId: "custom-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".custom",
              languageId: "custom-lang",
              factory: () => ({
                languageId: "custom-lang",
                fileExtensions: [".custom"],
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

      await loadPlugins([pluginPath]);

      const adapter = getAdapterForExtension(".custom");
      assert.ok(adapter);
      assert.strictEqual(adapter.languageId, "custom-lang");
    });

    it("should register multiple adapters from single plugin", async () => {
      const pluginPath = path.join(
        TEST_PLUGINS_DIR,
        "multi-adapter-plugin.mjs",
      );
      const pluginContent = `
        export const manifest = {
          name: "multi-adapter-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".ext1", languageId: "lang1" },
            { extension: ".ext2", languageId: "lang2" },
            { extension: ".ext3", languageId: "lang3" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".ext1",
              languageId: "lang1",
              factory: () => ({
                languageId: "lang1",
                fileExtensions: [".ext1"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            },
            {
              extension: ".ext2",
              languageId: "lang2",
              factory: () => ({
                languageId: "lang2",
                fileExtensions: [".ext2"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            },
            {
              extension: ".ext3",
              languageId: "lang3",
              factory: () => ({
                languageId: "lang3",
                fileExtensions: [".ext3"],
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

      await loadPlugins([pluginPath]);

      assert.ok(getAdapterForExtension(".ext1"));
      assert.ok(getAdapterForExtension(".ext2"));
      assert.ok(getAdapterForExtension(".ext3"));

      const extensions = getSupportedExtensions();
      assert.ok(extensions.includes(".ext1"));
      assert.ok(extensions.includes(".ext2"));
      assert.ok(extensions.includes(".ext3"));
    });

    it("should allow plugin to override built-in adapter", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "override-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "override-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".ts", languageId: "custom-typescript" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".ts",
              languageId: "custom-typescript",
              factory: () => ({
                languageId: "custom-typescript",
                fileExtensions: [".ts"],
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

      loadBuiltInAdapters();
      await loadPlugins([pluginPath]);

      const adapter = getAdapterForExtension(".ts");
      assert.ok(adapter);
      assert.strictEqual(adapter.languageId, "custom-typescript");

      const info = getAdapterInfo(".ts");
      assert.strictEqual(info.source, "plugin");
      assert.strictEqual(info.pluginName, "override-plugin");
    });
  });

  describe("getAdapterInfo", () => {
    it("should return info for built-in adapter", () => {
      loadBuiltInAdapters();

      const info = getAdapterInfo(".ts");
      assert.strictEqual(info.languageId, "typescript");
      assert.strictEqual(info.source, "builtin");
      assert.strictEqual(info.pluginName, undefined);
    });

    it("should return info for plugin adapter", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "info-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "info-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".info", languageId: "info-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".info",
              languageId: "info-lang",
              factory: () => ({
                languageId: "info-lang",
                fileExtensions: [".info"],
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

      await loadPlugins([pluginPath]);

      const info = getAdapterInfo(".info");
      assert.strictEqual(info.languageId, "info-lang");
      assert.strictEqual(info.source, "plugin");
      assert.strictEqual(info.pluginName, "info-plugin");
    });

    it("should return null info for unknown extension", () => {
      const info = getAdapterInfo(".unknown");
      assert.strictEqual(info.languageId, null);
      assert.strictEqual(info.source, null);
      assert.strictEqual(info.pluginName, undefined);
    });
  });

  describe("getLanguageIdForExtension with plugins", () => {
    it("should return language ID for plugin adapter", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "langid-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "langid-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".langtest", languageId: "test-lang-id" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".langtest",
              languageId: "test-lang-id",
              factory: () => ({
                languageId: "test-lang-id",
                fileExtensions: [".langtest"],
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

      await loadPlugins([pluginPath]);

      const langId = getLanguageIdForExtension(".langtest");
      assert.strictEqual(langId, "test-lang-id");
    });

    it("should return overridden language ID from plugin", async () => {
      const pluginPath = path.join(
        TEST_PLUGINS_DIR,
        "override-langid-plugin.mjs",
      );
      const pluginContent = `
        export const manifest = {
          name: "override-langid-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".ts", languageId: "overridden-typescript" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".ts",
              languageId: "overridden-typescript",
              factory: () => ({
                languageId: "overridden-typescript",
                fileExtensions: [".ts"],
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

      loadBuiltInAdapters();
      await loadPlugins([pluginPath]);

      const langId = getLanguageIdForExtension(".ts");
      assert.strictEqual(langId, "overridden-typescript");
    });
  });

  describe("getSupportedExtensions with plugins", () => {
    it("should include plugin extensions", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "supported-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "supported-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".supp1", languageId: "supp1-lang" },
            { extension: ".supp2", languageId: "supp2-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".supp1",
              languageId: "supp1-lang",
              factory: () => ({
                languageId: "supp1-lang",
                fileExtensions: [".supp1"],
                getParser: () => null,
                parse: () => null,
                extractSymbols: () => [],
                extractImports: () => [],
                extractCalls: () => []
              })
            },
            {
              extension: ".supp2",
              languageId: "supp2-lang",
              factory: () => ({
                languageId: "supp2-lang",
                fileExtensions: [".supp2"],
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

      await loadPlugins([pluginPath]);

      const extensions = getSupportedExtensions();
      assert.ok(extensions.includes(".supp1"));
      assert.ok(extensions.includes(".supp2"));
    });

    it("should include both built-in and plugin extensions", async () => {
      const pluginPath = path.join(TEST_PLUGINS_DIR, "mixed-plugin.mjs");
      const pluginContent = `
        export const manifest = {
          name: "mixed-plugin",
          version: "1.0.0",
          apiVersion: "${getHostApiVersion()}",
          adapters: [
            { extension: ".pluginext", languageId: "plugin-lang" }
          ]
        };

        export async function createAdapters() {
          return [
            {
              extension: ".pluginext",
              languageId: "plugin-lang",
              factory: () => ({
                languageId: "plugin-lang",
                fileExtensions: [".pluginext"],
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

      loadBuiltInAdapters();
      await loadPlugins([pluginPath]);

      const extensions = getSupportedExtensions();
      assert.ok(extensions.includes(".pluginext"));
      assert.ok(extensions.includes(".ts"));
      assert.ok(extensions.includes(".js"));
      assert.ok(extensions.includes(".py"));
    });
  });

  describe("registerAdapter with source tracking", () => {
    it("should allow manual registration with source specified", () => {
      registerAdapter(
        ".manual",
        "manual-lang",
        () => ({
          languageId: "manual-lang",
          fileExtensions: [".manual"],
          getParser: () => null,
          parse: () => null,
          extractSymbols: () => [],
          extractImports: () => [],
          extractCalls: () => [],
        }),
        "plugin",
        "manual-plugin",
      );

      const info = getAdapterInfo(".manual");
      assert.strictEqual(info.languageId, "manual-lang");
      assert.strictEqual(info.source, "plugin");
      assert.strictEqual(info.pluginName, "manual-plugin");
    });
  });
});
