import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSignatureJson,
  type SignatureLike,
  type SymbolKindLiteral,
} from "../../dist/indexer/parser/build-rows.js";

describe("buildSignatureJson", () => {
  it("preserves parser-provided rich signatures", () => {
    const signature: SignatureLike = {
      params: [{ name: "user", type: "User" }],
      returns: "Session",
      text: "function login(user: User): Session",
    };

    assert.equal(
      buildSignatureJson("function", "login", signature),
      JSON.stringify(signature),
    );
  });

  it("adds conservative text fallback for symbols without parser signatures", () => {
    const cases: Array<[SymbolKindLiteral, string, string]> = [
      ["function", "login", "function login"],
      ["class", "SessionStore", "class SessionStore"],
      ["type", "UserId", "type UserId"],
      ["variable", "DEFAULT_TIMEOUT_MS", "const DEFAULT_TIMEOUT_MS"],
      ["module", "auth", "module auth"],
    ];

    for (const [kind, name, text] of cases) {
      assert.equal(
        buildSignatureJson(kind, name, undefined),
        JSON.stringify({ text }),
      );
    }
  });
});
