import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("legacy ANN maintenance mode", () => {
  it("LEGACY_ANN_MAINTENANCE_MODE defaults to false", async () => {
    const { LEGACY_ANN_MAINTENANCE_MODE } = await import(
      "../../dist/config/constants.js"
    );
    assert.equal(LEGACY_ANN_MAINTENANCE_MODE, false);
  });
});
