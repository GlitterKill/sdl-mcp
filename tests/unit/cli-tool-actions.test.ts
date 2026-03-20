import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ALL_ACTION_NAMES } from "../../src/cli/commands/tool-actions.js";
import { ALL_ACTIONS } from "../../src/gateway/schemas.js";

describe("CLI tool actions", () => {
  it("stays in sync with the gateway action catalog", () => {
    assert.deepStrictEqual(
      [...ALL_ACTION_NAMES].sort(),
      [...ALL_ACTIONS].sort(),
    );
  });
});
