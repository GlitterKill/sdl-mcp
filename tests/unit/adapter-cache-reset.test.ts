import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getAdapterForExtension,
  loadBuiltInAdapters,
  resetRegistry,
} from "../../dist/indexer/adapter/registry.js";
import { clearCache as clearTypeScriptCache } from "../../dist/indexer/adapter/typescript.js";

describe("adapter cache reset", () => {
  beforeEach(() => {
    resetRegistry();
    loadBuiltInAdapters();
  });

  it("reloads a parser after the adapter cache is cleared", () => {
    const adapter = getAdapterForExtension(".ts");
    assert.ok(adapter);

    const firstParser = adapter.getParser();
    assert.ok(firstParser);
    assert.strictEqual(getAdapterForExtension(".ts"), adapter);

    clearTypeScriptCache();

    const secondParser = adapter.getParser();
    assert.ok(secondParser);
    assert.notStrictEqual(secondParser, firstParser);
  });
});
