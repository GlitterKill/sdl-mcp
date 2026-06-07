import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatRuntimeIdentityLine } from "../../dist/util/runtime-identity.js";

describe("runtime identity formatting", () => {
  it("normalizes the module path in CLI diagnostics", () => {
    assert.equal(
      formatRuntimeIdentityLine({
        version: "0.11.4",
        node: "v24.14.0",
        modulePath: "C:\\pkg\\sdl-mcp\\dist\\cli\\commands\\index.js",
      }),
      "Runtime: sdl-mcp 0.11.4; node=v24.14.0; module=C:/pkg/sdl-mcp/dist/cli/commands/index.js",
    );
  });

  it("supports a custom label for delegated server diagnostics", () => {
    assert.equal(
      formatRuntimeIdentityLine(
        {
          version: "0.11.4",
          node: "v24.14.0",
          modulePath: "F:/repo/dist/cli/transport/http.js",
        },
        "  Server runtime",
      ),
      "  Server runtime: sdl-mcp 0.11.4; node=v24.14.0; module=F:/repo/dist/cli/transport/http.js",
    );
  });
});
