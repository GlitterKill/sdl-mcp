import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MANUAL_DESCRIPTION,
  CHAIN_DESCRIPTION,
  ACTION_SEARCH_DESCRIPTION,
} from "../../src/code-mode/descriptions.js";

/**
 * Tests for src/code-mode/descriptions.ts — description constants
 * for the code-mode tools (manual, chain, action search).
 */

describe("Code-mode descriptions", () => {
  const descriptions = [
    { name: "MANUAL_DESCRIPTION", value: MANUAL_DESCRIPTION },
    { name: "CHAIN_DESCRIPTION", value: CHAIN_DESCRIPTION },
    { name: "ACTION_SEARCH_DESCRIPTION", value: ACTION_SEARCH_DESCRIPTION },
  ];

  for (const { name, value } of descriptions) {
    it(`${name} is a non-empty string`, () => {
      assert.strictEqual(typeof value, "string");
      assert.ok(value.length > 0, `${name} should not be empty`);
    });

    it(`${name} is not undefined or null`, () => {
      assert.notStrictEqual(value, undefined);
      assert.notStrictEqual(value, null);
    });

    it(`${name} contains no undefined placeholders`, () => {
      assert.ok(
        !value.includes("undefined"),
        `${name} should not contain 'undefined'`,
      );
    });
  }

  it("MANUAL_DESCRIPTION mentions SDL-MCP API manual", () => {
    assert.ok(MANUAL_DESCRIPTION.includes("SDL-MCP"));
    assert.ok(MANUAL_DESCRIPTION.includes("manual"));
  });

  it("MANUAL_DESCRIPTION mentions sdl.chain", () => {
    assert.ok(MANUAL_DESCRIPTION.includes("sdl.chain"));
  });

  it("CHAIN_DESCRIPTION mentions chain of operations", () => {
    assert.ok(CHAIN_DESCRIPTION.includes("chain"));
  });

  it("CHAIN_DESCRIPTION mentions $N references", () => {
    assert.ok(CHAIN_DESCRIPTION.includes("$N"));
  });

  it("CHAIN_DESCRIPTION mentions budget tracking", () => {
    assert.ok(CHAIN_DESCRIPTION.includes("budget"));
  });

  it("CHAIN_DESCRIPTION mentions transforms", () => {
    assert.ok(CHAIN_DESCRIPTION.includes("dataPick"));
    assert.ok(CHAIN_DESCRIPTION.includes("dataMap"));
    assert.ok(CHAIN_DESCRIPTION.includes("dataFilter"));
    assert.ok(CHAIN_DESCRIPTION.includes("dataSort"));
    assert.ok(CHAIN_DESCRIPTION.includes("dataTemplate"));
  });

  it("ACTION_SEARCH_DESCRIPTION mentions search and ranked matches", () => {
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("Search"));
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("ranked"));
  });

  it("ACTION_SEARCH_DESCRIPTION mentions discovery", () => {
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("discovery"));
  });
});
