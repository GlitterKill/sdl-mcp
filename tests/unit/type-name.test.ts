import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeTypeName,
  stripGenericArguments,
} from "../../dist/util/type-name.js";

describe("type-name helpers", () => {
  it("strips nested generic arguments without leaking inner type syntax", () => {
    assert.equal(
      stripGenericArguments("Result<Page<UserRecord[]>>"),
      "Result",
    );
  });

  it("normalizes generic array type names for summary extraction", () => {
    assert.equal(
      normalizeTypeName("Dictionary<string, List<UserRecord[]>>[][]"),
      "Dictionary",
    );
  });
});
