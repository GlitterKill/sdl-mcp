import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  estimateTokens,
  estimateTokensCoarse,
} from "../../dist/util/tokenize.js";

describe("token estimates", () => {
  it("keeps the coarse estimate on the established chars/4 formula", () => {
    assert.equal(estimateTokensCoarse(""), 0);
    assert.equal(estimateTokensCoarse("1234"), 1);
    assert.equal(estimateTokensCoarse("12345"), 2);
  });

  it("distinguishes coarse estimates from structural token estimates", () => {
    const code = '{"value":[1,2,3]}';

    assert.notEqual(estimateTokensCoarse(code), estimateTokens(code));
  });
});
