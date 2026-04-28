import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeSliceForWireFormat } from "../../dist/mcp/tools/slice-wire-format.js";
import { WireFormatRetiredError } from "../../dist/mcp/errors.js";

const stubSlice = {
  repoId: "test",
  versionId: "v1",
  budget: { maxCards: 5, maxEstimatedTokens: 1000 },
  startSymbols: [],
  symbolIndex: [],
  cards: [],
  edges: [],
} as const;

test("wireFormatVersion 1 throws WireFormatRetiredError", () => {
  assert.throws(
    () =>
      serializeSliceForWireFormat(
        stubSlice as unknown as never,
        "compact" as never,
        1,
      ),
    (err: unknown) =>
      err instanceof WireFormatRetiredError &&
      err.retiredVersion === 1 &&
      /retired in 0\.11\.0/.test(err.migrationHint),
  );
});

test("wireFormatVersion 2 throws WireFormatRetiredError", () => {
  assert.throws(
    () =>
      serializeSliceForWireFormat(
        stubSlice as unknown as never,
        "compact" as never,
        2,
      ),
    (err: unknown) =>
      err instanceof WireFormatRetiredError && err.retiredVersion === 2,
  );
});

test("wireFormatVersion 3 still emits compact payload", () => {
  const result = serializeSliceForWireFormat(
    stubSlice as unknown as never,
    "compact" as never,
    3,
  );
  assert.equal(result.format, "compact");
});

test("wireFormatVersion default (undefined) does not throw", () => {
  // Regression guard: the slice handler defaults wireFormatVersion to 3 when
  // the caller omits it. Ensure the dispatcher accepts the undefined path
  // without tripping WireFormatRetiredError.
  const result = serializeSliceForWireFormat(
    stubSlice as unknown as never,
    "compact" as never,
    undefined,
  );
  assert.equal(result.format, "compact");
});
