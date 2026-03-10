/**
 * Tests for LadybugDB config schema validation
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  GraphDatabaseConfigSchema,
  AppConfigSchema,
} from "../../src/config/types.js";

describe("GraphDatabaseConfigSchema", () => {
  describe("valid configurations", () => {
    it("should accept null path", () => {
      const result = GraphDatabaseConfigSchema.parse({ path: null });
      assert.deepStrictEqual(result, { path: null });
    });

    it("should accept undefined path", () => {
      const result = GraphDatabaseConfigSchema.parse({});
      assert.strictEqual(result.path, undefined);
    });

    it("should accept a valid string path", () => {
      const result = GraphDatabaseConfigSchema.parse({
        path: "./data/graph.lbug",
      });
      assert.deepStrictEqual(result, { path: "./data/graph.lbug" });
    });

    it("should accept an absolute path", () => {
      const result = GraphDatabaseConfigSchema.parse({
        path: "/var/lib/sdlmcp/graph.lbug",
      });
      assert.deepStrictEqual(result, { path: "/var/lib/sdlmcp/graph.lbug" });
    });

    it("should accept empty string path (nullish allows it)", () => {
      const result = GraphDatabaseConfigSchema.parse({ path: "" });
      assert.deepStrictEqual(result, { path: "" });
    });
  });

  describe("invalid configurations", () => {
    it("should reject non-string, non-null path", () => {
      assert.throws(() => {
        GraphDatabaseConfigSchema.parse({ path: 123 });
      });
    });
  });
});

describe("AppConfigSchema with graphDatabase", () => {
  const minimalConfig = {
    repos: [{ repoId: "test", rootPath: "." }],
    dbPath: "./test.sqlite",
    policy: { maxWindowLines: 180, maxWindowTokens: 1400 },
  };

  it("should accept config without graphDatabase (backward compatibility)", () => {
    const result = AppConfigSchema.parse(minimalConfig);
    assert.strictEqual(result.graphDatabase, undefined);
  });

  it("should accept config with graphDatabase.path as null", () => {
    const result = AppConfigSchema.parse({
      ...minimalConfig,
      graphDatabase: { path: null },
    });
    assert.deepStrictEqual(result.graphDatabase, { path: null });
  });

  it("should accept config with graphDatabase.path as string", () => {
    const result = AppConfigSchema.parse({
      ...minimalConfig,
      graphDatabase: { path: "./custom.lbug" },
    });
    assert.deepStrictEqual(result.graphDatabase, { path: "./custom.lbug" });
  });

  it("should accept config with empty graphDatabase object", () => {
    const result = AppConfigSchema.parse({
      ...minimalConfig,
      graphDatabase: {},
    });
    assert.strictEqual(result.graphDatabase?.path, undefined);
  });
});
