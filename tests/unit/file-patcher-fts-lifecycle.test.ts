import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { IndexError } from "../../dist/domain/errors.js";
import {
  withSymbolFtsPausedForPatch,
  type SymbolFtsPatchLifecycleDependencies,
} from "../../dist/live-index/file-patcher.js";

const conn = {} as never;

function deps(
  overrides: Partial<SymbolFtsPatchLifecycleDependencies> = {},
): SymbolFtsPatchLifecycleDependencies {
  return {
    getConfig: () => ({ enabled: true, indexName: "symbol_search_text_v1" }),
    drop: async () => ({ status: "dropped" }),
    ensure: async () => ({ status: "exists" }),
    logRebuildFailure: () => {},
    ...overrides,
  };
}

describe("withSymbolFtsPausedForPatch", () => {
  it("skips FTS work when disabled", async () => {
    let dropCalled = false;
    let ensureCalled = false;

    const result = await withSymbolFtsPausedForPatch(
      conn,
      async () => "patched",
      deps({
        getConfig: () => ({ enabled: false, indexName: "symbol_search_text_v1" }),
        drop: async () => {
          dropCalled = true;
          return { status: "dropped" };
        },
        ensure: async () => {
          ensureCalled = true;
          return { status: "exists" };
        },
      }),
    );

    assert.equal(result, "patched");
    assert.equal(dropCalled, false);
    assert.equal(ensureCalled, false);
  });

  it("does not mutate when dropping Symbol FTS fails", async () => {
    let mutated = false;

    await assert.rejects(
      () =>
        withSymbolFtsPausedForPatch(
          conn,
          async () => {
            mutated = true;
          },
          deps({
            drop: async () => ({ status: "failed", error: "drop denied" }),
          }),
        ),
      (err) =>
        err instanceof IndexError &&
        err.message.includes("drop Symbol FTS index"),
    );

    assert.equal(mutated, false);
  });

  it("rebuilds absent Symbol FTS after a successful mutation", async () => {
    let ensured = false;

    const result = await withSymbolFtsPausedForPatch(
      conn,
      async () => 42,
      deps({
        drop: async () => ({ status: "absent" }),
        ensure: async () => {
          ensured = true;
          return { status: "created" };
        },
      }),
    );

    assert.equal(result, 42);
    assert.equal(ensured, true);
  });

  it("accepts an empty Symbol FTS rebuild result", async () => {
    const result = await withSymbolFtsPausedForPatch(
      conn,
      async () => 42,
      deps({
        drop: async () => ({ status: "absent" }),
        ensure: async () => ({ status: "empty" }),
      }),
    );

    assert.equal(result, 42);
  });

  it("does not rebuild absent Symbol FTS after mutation failure", async () => {
    const mutationError = new Error("mutation failed");
    let ensureCalls = 0;

    await assert.rejects(
      () =>
        withSymbolFtsPausedForPatch(
          conn,
          async () => {
            throw mutationError;
          },
          deps({
            drop: async () => ({ status: "absent" }),
            ensure: async () => {
              ensureCalls += 1;
              return { status: "exists" };
            },
          }),
        ),
      (error) => error === mutationError,
    );

    assert.equal(ensureCalls, 0);
  });

  it("rebuilds dropped Symbol FTS after mutation failure and preserves the mutation error", async () => {
    const primary = new Error("mutation failed");
    let ensured = false;

    await assert.rejects(
      () =>
        withSymbolFtsPausedForPatch(
          conn,
          async () => {
            throw primary;
          },
          deps({
            ensure: async () => {
              ensured = true;
              return { status: "exists" };
            },
          }),
        ),
      primary,
    );

    assert.equal(ensured, true);
  });

  it("rejects when the mutation rejects with undefined", async () => {
    let rejected = false;
    try {
      await withSymbolFtsPausedForPatch(
        conn,
        () => Promise.reject(undefined),
        deps(),
      );
    } catch (error) {
      rejected = true;
      assert.equal(error, undefined);
    }

    assert.equal(rejected, true);
  });

  it("reports rebuild failure after a successful mutation", async () => {
    await assert.rejects(
      () =>
        withSymbolFtsPausedForPatch(
          conn,
          async () => "patched",
          deps({
            ensure: async () => ({ status: "failed", error: "create failed" }),
          }),
        ),
      (err) =>
        err instanceof IndexError &&
        err.message.includes("rebuild Symbol FTS index"),
    );
  });

  it("logs rebuild failure but keeps mutation error primary when both fail", async () => {
    const primary = new Error("mutation failed");
    let loggedError: Error | null = null;

    await assert.rejects(
      () =>
        withSymbolFtsPausedForPatch(
          conn,
          async () => {
            throw primary;
          },
          deps({
            ensure: async () => ({ status: "failed", error: "create failed" }),
            logRebuildFailure: (error) => {
              loggedError = error;
            },
          }),
        ),
      (err) =>
        err === primary &&
        err.message.includes("Symbol FTS may be absent") &&
        err.message.includes("rebuild Symbol FTS index"),
    );

    assert.ok(loggedError instanceof IndexError);
    assert.match(loggedError?.message ?? "", /rebuild Symbol FTS index/);
  });
});
