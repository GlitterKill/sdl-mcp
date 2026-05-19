import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveClientKey } from "../../dist/server.js";

describe("server client key derivation", () => {
  it("prefers explicit low-cardinality client header over session id", () => {
    assert.equal(
      deriveClientKey("session-123", {
        headers: { "x-sdl-client": "Codex Desktop" },
      }),
      "client:Codex_Desktop",
    );
  });

  it("uses a client-family key from user agent before session fallback", () => {
    assert.equal(
      deriveClientKey("session-123", {
        headers: { "user-agent": "Codex/1.2.3 Windows" },
      }),
      "ua:codex",
    );
  });

  it("falls back to session id and then stdio", () => {
    assert.equal(deriveClientKey("session-123"), "session:session-123");
    assert.equal(deriveClientKey(), "stdio");
  });
});
