import { describe, it } from "node:test";
import assert from "node:assert";
import {
  QUERY_DESCRIPTION,
  CODE_DESCRIPTION,
  REPO_DESCRIPTION,
  AGENT_DESCRIPTION,
} from "../../src/gateway/descriptions.js";

/**
 * Tests for src/gateway/descriptions.ts — compact tool descriptions for gateway tools.
 * Verifies all descriptions are non-empty strings with expected content.
 */

describe("Gateway descriptions", () => {
  const descriptions = [
    { name: "QUERY_DESCRIPTION", value: QUERY_DESCRIPTION },
    { name: "CODE_DESCRIPTION", value: CODE_DESCRIPTION },
    { name: "REPO_DESCRIPTION", value: REPO_DESCRIPTION },
    { name: "AGENT_DESCRIPTION", value: AGENT_DESCRIPTION },
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
  }

  it("QUERY_DESCRIPTION starts with sdl.query", () => {
    assert.ok(
      QUERY_DESCRIPTION.startsWith("sdl.query"),
      "should start with sdl.query",
    );
  });

  it("CODE_DESCRIPTION starts with sdl.code", () => {
    assert.ok(
      CODE_DESCRIPTION.startsWith("sdl.code"),
      "should start with sdl.code",
    );
  });

  it("REPO_DESCRIPTION starts with sdl.repo", () => {
    assert.ok(
      REPO_DESCRIPTION.startsWith("sdl.repo"),
      "should start with sdl.repo",
    );
  });

  it("AGENT_DESCRIPTION starts with sdl.agent", () => {
    assert.ok(
      AGENT_DESCRIPTION.startsWith("sdl.agent"),
      "should start with sdl.agent",
    );
  });

  it("QUERY_DESCRIPTION mentions key query actions", () => {
    assert.ok(QUERY_DESCRIPTION.includes("symbol.search"));
    assert.ok(QUERY_DESCRIPTION.includes("symbol.getCard"));
    assert.ok(QUERY_DESCRIPTION.includes("slice.build"));
    assert.ok(QUERY_DESCRIPTION.includes("delta.get"));
  });

  it("CODE_DESCRIPTION mentions key code actions", () => {
    assert.ok(CODE_DESCRIPTION.includes("code.needWindow"));
    assert.ok(CODE_DESCRIPTION.includes("code.getSkeleton"));
    assert.ok(CODE_DESCRIPTION.includes("code.getHotPath"));
  });

  it("REPO_DESCRIPTION mentions key repo actions", () => {
    assert.ok(REPO_DESCRIPTION.includes("repo.register"));
    assert.ok(REPO_DESCRIPTION.includes("repo.status"));
    assert.ok(REPO_DESCRIPTION.includes("index.refresh"));
    assert.ok(REPO_DESCRIPTION.includes("policy.get"));
  });

  it("AGENT_DESCRIPTION mentions key agent actions", () => {
    assert.ok(AGENT_DESCRIPTION.includes("agent.orchestrate"));
    assert.ok(AGENT_DESCRIPTION.includes("buffer.push"));
    assert.ok(AGENT_DESCRIPTION.includes("memory.store"));
    assert.ok(AGENT_DESCRIPTION.includes("runtime.execute"));
  });

  it("each description mentions Actions:", () => {
    for (const { name, value } of descriptions) {
      assert.ok(
        value.includes("Actions:"),
        `${name} should include 'Actions:' section`,
      );
    }
  });

  it("each description mentions repoId and action params", () => {
    for (const { name, value } of descriptions) {
      assert.ok(
        value.includes("repoId"),
        `${name} should mention repoId`,
      );
      assert.ok(
        value.includes("action"),
        `${name} should mention action`,
      );
    }
  });
});
