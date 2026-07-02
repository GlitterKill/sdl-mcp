import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compactDirectoryExports } from "../../dist/graph/overview.js";

describe("compactDirectoryExports", () => {
  it("removes duplicate and synthetic export names", () => {
    assert.deepEqual(
      compactDirectoryExports([
        "createServer",
        "typeLiteral1",
        "createServer",
        "handler.(params)",
        "MCPServer",
      ]),
      ["createServer", "MCPServer"],
    );
  });
});
