import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveRepoLanguages } from "../../dist/mcp/tools/repo.js";

describe("repo.register language defaults", () => {
  it("defaults to all supported languages when languages are omitted", () => {
    const languages = resolveRepoLanguages(undefined);

    assert.ok(languages.includes("ts"));
    assert.ok(languages.includes("py"));
    assert.ok(languages.includes("go"));
    assert.ok(languages.includes("java"));
    assert.ok(languages.includes("cs"));
    assert.ok(languages.includes("c"));
    assert.ok(languages.includes("cpp"));
    assert.ok(languages.includes("php"));
    assert.ok(languages.includes("rs"));
    assert.ok(languages.includes("kt"));
    assert.ok(languages.includes("sh"));
  });
});
