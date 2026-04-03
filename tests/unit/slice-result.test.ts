import { describe, it } from "node:test";
import assert from "node:assert";
import {
  sliceOk,
  sliceErr,
  isSliceOk,
  isSliceErr,
  sliceErrorToMessage,
  sliceErrorToCode,
  sliceErrorToResponse,
} from "../../dist/graph/slice/result.js";

describe("sliceOk / sliceErr", () => {
  it("sliceOk wraps a slice in { ok: true }", () => {
    const fakeSlice = { cards: [] } as any;
    const result = sliceOk(fakeSlice);
    assert.strictEqual(result.ok, true);
    assert.strictEqual((result as any).slice, fakeSlice);
  });

  it("sliceErr wraps an error in { ok: false }", () => {
    const error = { type: "invalid_repo" as const, repoId: "r1" };
    const result = sliceErr(error);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual((result as any).error, error);
  });
});

describe("isSliceOk / isSliceErr", () => {
  it("isSliceOk returns true for ok results", () => {
    const result = sliceOk({ cards: [] } as any);
    assert.strictEqual(isSliceOk(result), true);
    assert.strictEqual(isSliceErr(result), false);
  });

  it("isSliceErr returns true for error results", () => {
    const result = sliceErr({ type: "internal", message: "boom" });
    assert.strictEqual(isSliceErr(result), true);
    assert.strictEqual(isSliceOk(result), false);
  });
});

describe("sliceErrorToMessage", () => {
  it("invalid_repo", () => {
    const msg = sliceErrorToMessage({ type: "invalid_repo", repoId: "r1" });
    assert.strictEqual(msg, "Repository not found: r1");
  });

  it("no_version", () => {
    const msg = sliceErrorToMessage({ type: "no_version", repoId: "r1" });
    assert.ok(msg.includes("No version found"));
    assert.ok(msg.includes("r1"));
  });

  it("no_symbols without entrySymbols", () => {
    const msg = sliceErrorToMessage({ type: "no_symbols", repoId: "r1" });
    assert.ok(msg.includes("No symbols indexed"));
  });

  it("no_symbols with entrySymbols", () => {
    const msg = sliceErrorToMessage({
      type: "no_symbols",
      repoId: "r1",
      entrySymbols: ["sym1"],
    });
    assert.ok(msg.includes("No symbols found for entry symbols"));
  });

  it("missing_entry_hint", () => {
    const msg = sliceErrorToMessage({ type: "missing_entry_hint", repoId: "r1" });
    assert.ok(msg.includes("At least one entry symbol"));
    assert.ok(msg.includes("r1"));
  });

  it("policy_denied", () => {
    const msg = sliceErrorToMessage({
      type: "policy_denied",
      reason: "too big",
    });
    assert.ok(msg.includes("Policy denied"));
    assert.ok(msg.includes("too big"));
  });

  it("internal without cause", () => {
    const msg = sliceErrorToMessage({ type: "internal", message: "oops" });
    assert.strictEqual(msg, "Internal error: oops");
  });

  it("internal with cause", () => {
    const msg = sliceErrorToMessage({
      type: "internal",
      message: "oops",
      cause: "db down",
    });
    assert.ok(msg.includes("oops"));
    assert.ok(msg.includes("db down"));
  });
});

describe("sliceErrorToCode", () => {
  it("maps all 6 error types to correct codes", () => {
    assert.strictEqual(
      sliceErrorToCode({ type: "invalid_repo", repoId: "r1" }),
      "INVALID_REPO",
    );
    assert.strictEqual(
      sliceErrorToCode({ type: "no_version", repoId: "r1" }),
      "NO_VERSION",
    );
    assert.strictEqual(
      sliceErrorToCode({ type: "no_symbols", repoId: "r1" }),
      "NO_SYMBOLS",
    );
    assert.strictEqual(
      sliceErrorToCode({ type: "missing_entry_hint", repoId: "r1" }),
      "MISSING_ENTRY_HINT",
    );
    assert.strictEqual(
      sliceErrorToCode({ type: "policy_denied", reason: "x" }),
      "POLICY_DENIED",
    );
    assert.strictEqual(
      sliceErrorToCode({ type: "internal", message: "x" }),
      "INTERNAL_ERROR",
    );
  });
});

describe("sliceErrorToResponse", () => {
  it("returns correct response shape with repoId", () => {
    const resp = sliceErrorToResponse({ type: "invalid_repo", repoId: "r1" });
    assert.strictEqual(resp.error.code, "INVALID_REPO");
    assert.strictEqual(resp.error.type, "invalid_repo");
    assert.strictEqual(resp.error.repoId, "r1");
    assert.ok(typeof resp.error.message === "string");
  });

  it("returns undefined repoId for non-repo errors", () => {
    const resp = sliceErrorToResponse({ type: "internal", message: "boom" });
    assert.strictEqual(resp.error.repoId, undefined);
    assert.strictEqual(resp.error.type, "internal");
  });
});
