import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import {
  registerAdapter,
  getAdapterForExtension,
  getSupportedExtensions,
  getLanguageIdForExtension,
  loadBuiltInAdapters,
} from "../../dist/indexer/adapter/registry.js";
import type { LanguageAdapter } from "../../dist/indexer/adapter/LanguageAdapter.js";

describe("Adapter Registry", () => {
  beforeEach(() => {
    loadBuiltInAdapters();
  });

  it("should return null for unregistered extensions", () => {
    const adapter = getAdapterForExtension(".xyz");
    assert.strictEqual(adapter, null);
  });

  it("should return null for unregistered language IDs", () => {
    const langId = getLanguageIdForExtension(".xyz");
    assert.strictEqual(langId, null);
  });

  it("should register adapters with factory functions", () => {
    const mockAdapter: LanguageAdapter = {
      languageId: "test",
      fileExtensions: [".test"],
      getParser: () => null,
      parse: () => null,
      extractSymbols: () => [],
      extractImports: () => [],
      extractCalls: () => [],
    };

    registerAdapter(".test", "test", () => mockAdapter);

    const adapter = getAdapterForExtension(".test");
    assert.strictEqual(adapter, mockAdapter);
  });

  it("should lazy load adapters", () => {
    let loadCount = 0;

    registerAdapter(".lazy", "lazy", () => {
      loadCount++;
      return {
        languageId: "lazy",
        fileExtensions: [".lazy"],
        getParser: () => null,
        parse: () => null,
        extractSymbols: () => [],
        extractImports: () => [],
        extractCalls: () => [],
      };
    });

    assert.strictEqual(loadCount, 0);

    getAdapterForExtension(".lazy");
    assert.strictEqual(loadCount, 1);

    getAdapterForExtension(".lazy");
    assert.strictEqual(loadCount, 1);
  });

  it("should return supported extensions", () => {
    registerAdapter(".ext1", "lang1", () => ({
      languageId: "lang1",
      fileExtensions: [".ext1"],
      getParser: () => null,
      parse: () => null,
      extractSymbols: () => [],
      extractImports: () => [],
      extractCalls: () => [],
    }));

    registerAdapter(".ext2", "lang2", () => ({
      languageId: "lang2",
      fileExtensions: [".ext2"],
      getParser: () => null,
      parse: () => null,
      extractSymbols: () => [],
      extractImports: () => [],
      extractCalls: () => [],
    }));

    const extensions = getSupportedExtensions();
    assert.ok(extensions.includes(".ext1"));
    assert.ok(extensions.includes(".ext2"));
  });

  it("should be case-insensitive for extensions", () => {
    const mockAdapter: LanguageAdapter = {
      languageId: "case-test",
      fileExtensions: [".test"],
      getParser: () => null,
      parse: () => null,
      extractSymbols: () => [],
      extractImports: () => [],
      extractCalls: () => [],
    };

    registerAdapter(".test", "case-test", () => mockAdapter);

    assert.strictEqual(getAdapterForExtension(".test"), mockAdapter);
    assert.strictEqual(getAdapterForExtension(".TEST"), mockAdapter);
    assert.strictEqual(getAdapterForExtension(".Test"), mockAdapter);
  });

  it("should return language ID for registered extensions", () => {
    registerAdapter(".ts", "typescript", () => ({
      languageId: "typescript",
      fileExtensions: [".ts"],
      getParser: () => null,
      parse: () => null,
      extractSymbols: () => [],
      extractImports: () => [],
      extractCalls: () => [],
    }));

    const langId = getLanguageIdForExtension(".ts");
    assert.strictEqual(langId, "typescript");
  });
});
