import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMissingSymbolExternalColumnError } from "../../dist/db/ladybug-symbols.js";

describe("LadybugDB symbol error classification", () => {
  it("recognizes missing Symbol.external column errors", () => {
    assert.equal(
      isMissingSymbolExternalColumnError(
        new Error("Binder exception: Cannot find property external for s"),
      ),
      true,
    );
    assert.equal(
      isMissingSymbolExternalColumnError(
        new Error("Property external does not exist on node table Symbol"),
      ),
      true,
    );
  });

  it("does not hide unrelated query failures", () => {
    assert.equal(
      isMissingSymbolExternalColumnError(new Error("Connection reset by peer")),
      false,
    );
    assert.equal(
      isMissingSymbolExternalColumnError(
        new Error("Node table Symbol does not exist"),
      ),
      false,
    );
  });
});
