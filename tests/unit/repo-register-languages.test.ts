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
    assert.ok(languages.includes("rs"));
    assert.ok(languages.includes("kt"));
    assert.equal(languages.includes("php"), false);
    assert.equal(languages.includes("sh"), false);
    assert.equal(languages.includes("powershell"), false);
    assert.equal(languages.includes("ruby"), false);
    assert.equal(languages.includes("lua"), false);
    assert.equal(languages.includes("dart"), false);
    assert.equal(languages.includes("swift"), false);
    assert.equal(languages.includes("groovy"), false);
    assert.equal(languages.includes("perl"), false);
    assert.equal(languages.includes("r"), false);
    assert.equal(languages.includes("elixir"), false);
    assert.equal(languages.includes("fsharp"), false);
    assert.equal(languages.includes("fortran"), false);
    assert.equal(languages.includes("haskell"), false);
    assert.equal(languages.includes("julia"), false);
    assert.equal(languages.includes("gleam"), false);
    assert.equal(languages.includes("zig"), false);
  });
});
