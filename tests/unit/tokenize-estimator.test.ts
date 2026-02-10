import { describe, it } from "node:test";
import assert from "node:assert";
import { estimateTokens } from "../../src/util/tokenize.js";

describe("token estimate model", () => {
  it("returns 0 for empty input", () => {
    assert.strictEqual(estimateTokens(""), 0);
  });

  it("uses ~3.5 chars/token for prose-like text", () => {
    assert.strictEqual(estimateTokens("abcdefghij"), 3);
    assert.strictEqual(estimateTokens("abcdefghijklmnopqrstuvwxyz"), 8);
  });

  it("counts JSON structural characters as 1:1 overhead", () => {
    const structuralOnly = '{}[]:,"';
    assert.strictEqual(estimateTokens(structuralOnly), structuralOnly.length);
  });

  it("estimates JSON payloads higher than legacy chars/4 heuristic", () => {
    const json = '{"repoId":"my-repo","edges":[[0,1,"call",1],[1,2,"import",0.6]]}';
    const legacy = Math.ceil(json.length / 4);
    const estimate = estimateTokens(json);
    assert.ok(estimate > legacy);
  });
});
