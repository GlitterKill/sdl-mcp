import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MANUAL_DESCRIPTION,
  WORKFLOW_DESCRIPTION,
  CONTEXT_DESCRIPTION,
  ACTION_SEARCH_DESCRIPTION,
} from "../../dist/code-mode/descriptions.js";

/**
 * Tests for src/code-mode/descriptions.ts — description constants
 * for the code-mode tools (manual, workflow, context, action search).
 */

describe("Code-mode descriptions", () => {
  const descriptions = [
    { name: "MANUAL_DESCRIPTION", value: MANUAL_DESCRIPTION },
    { name: "WORKFLOW_DESCRIPTION", value: WORKFLOW_DESCRIPTION },
    { name: "CONTEXT_DESCRIPTION", value: CONTEXT_DESCRIPTION },
    { name: "ACTION_SEARCH_DESCRIPTION", value: ACTION_SEARCH_DESCRIPTION }];

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

  it("MANUAL_DESCRIPTION mentions sdl.workflow", () => {
    assert.ok(MANUAL_DESCRIPTION.includes("sdl.workflow"));
  });

  it("WORKFLOW_DESCRIPTION mentions workflow operations", () => {
    assert.ok(WORKFLOW_DESCRIPTION.includes("workflow"));
  });

  it("WORKFLOW_DESCRIPTION mentions $N references", () => {
    assert.ok(WORKFLOW_DESCRIPTION.includes("$N"));
  });

  it("WORKFLOW_DESCRIPTION mentions budget tracking", () => {
    assert.ok(WORKFLOW_DESCRIPTION.includes("budget"));
  });

  it("WORKFLOW_DESCRIPTION mentions transforms", () => {
    assert.ok(WORKFLOW_DESCRIPTION.includes("dataPick"));
    assert.ok(WORKFLOW_DESCRIPTION.includes("dataMap"));
    assert.ok(WORKFLOW_DESCRIPTION.includes("dataFilter"));
    assert.ok(WORKFLOW_DESCRIPTION.includes("dataSort"));
    assert.ok(WORKFLOW_DESCRIPTION.includes("dataTemplate"));
  });

  it("CONTEXT_DESCRIPTION mentions context retrieval", () => {
    assert.ok(CONTEXT_DESCRIPTION.includes("sdl.context"));
    assert.ok(CONTEXT_DESCRIPTION.includes("context"));
  });

  it("ACTION_SEARCH_DESCRIPTION mentions search and ranked matches", () => {
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("Search"));
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("ranked"));
  });

  it("ACTION_SEARCH_DESCRIPTION mentions discovery", () => {
    assert.ok(ACTION_SEARCH_DESCRIPTION.includes("discovery"));
  });
});
