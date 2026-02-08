import { describe, it } from "node:test";
import assert from "node:assert";

import {
  validateApiVersion,
  validateManifest,
  type PluginManifest,
  PLUGIN_API_VERSION,
} from "../../dist/indexer/adapter/plugin/types.js";

describe("Plugin Types", () => {
  describe("validateApiVersion", () => {
    it("should accept matching major versions", () => {
      const result = validateApiVersion("1.0.0", "1.2.0");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it("should reject mismatched major versions", () => {
      const result = validateApiVersion("2.0.0", "1.0.0");
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes("Incompatible API version"));
    });

    it("should use host API version by default", () => {
      const result = validateApiVersion(PLUGIN_API_VERSION);
      assert.strictEqual(result.valid, true);
    });

    it("should reject zero major version", () => {
      const result = validateApiVersion("0.1.0", "1.0.0");
      assert.strictEqual(result.valid, false);
    });
  });

  describe("validateManifest", () => {
    it("should validate a correct manifest", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        description: "Test plugin",
        adapters: [
          {
            extension: ".test",
            languageId: "test-lang",
          },
        ],
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it("should reject manifest with missing required fields", () => {
      const manifest = {
        name: "test-plugin",
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it("should reject manifest with invalid API version", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        version: "1.0.0",
        apiVersion: "2.0.0",
        adapters: [],
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, false);
      assert.ok(
        result.errors.some((e) => e.includes("Incompatible API version")),
      );
    });

    it("should accept manifest with optional fields", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        description: "Test plugin",
        author: "Test Author",
        license: "MIT",
        adapters: [
          {
            extension: ".test",
            languageId: "test-lang",
          },
        ],
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, true);
    });

    it("should reject manifest with invalid adapter structure", () => {
      const manifest = {
        name: "test-plugin",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        adapters: [
          {
            extension: ".test",
          },
        ],
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("languageId")));
    });

    it("should reject manifest with empty adapter array", () => {
      const manifest: PluginManifest = {
        name: "test-plugin",
        version: "1.0.0",
        apiVersion: PLUGIN_API_VERSION,
        adapters: [],
      };

      const result = validateManifest(manifest);
      assert.strictEqual(result.valid, true);
    });
  });
});
