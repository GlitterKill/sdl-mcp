/**
 * repo-root-allowlist.test.ts
 *
 * Unit tests for the security allowlist logic that prevents MCP clients from
 * registering arbitrary filesystem paths as repositories.
 *
 * Tests the pure `checkRepoRootAllowlist` helper directly — no DB required.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRepoRootAllowlist } from "../../dist/mcp/tools/repo.js";

const base = tmpdir();
const allowedRoot = join(base, "allowed-repos");
const validSubPath = join(allowedRoot, "myproject");
const deepSubPath = join(allowedRoot, "team", "myproject");
const outsidePath = join(base, "other-repos", "evil");
// A path that *starts with* the allowed root string but is not inside it
// e.g. /tmp/allowed-repos-evil vs /tmp/allowed-repos
const siblingTrickPath = join(base, "allowed-repos-sibling");

describe("checkRepoRootAllowlist", () => {
  it("succeeds when allowlist is empty (backward-compatible unrestricted mode)", () => {
    // Any path must be accepted when no roots are configured.
    assert.doesNotThrow(() => checkRepoRootAllowlist(outsidePath, []));
  });

  it("succeeds when path exactly equals an allowed root", () => {
    assert.doesNotThrow(() =>
      checkRepoRootAllowlist(allowedRoot, [allowedRoot]),
    );
  });

  it("succeeds when path is a direct child of an allowed root", () => {
    assert.doesNotThrow(() =>
      checkRepoRootAllowlist(validSubPath, [allowedRoot]),
    );
  });

  it("succeeds when path is a deep descendant of an allowed root", () => {
    assert.doesNotThrow(() =>
      checkRepoRootAllowlist(deepSubPath, [allowedRoot]),
    );
  });

  it("succeeds when path matches the second entry in a multi-root allowlist", () => {
    const anotherAllowed = join(base, "another-allowed");
    assert.doesNotThrow(() =>
      checkRepoRootAllowlist(validSubPath, [anotherAllowed, allowedRoot]),
    );
  });

  it("throws ValidationError when path is outside all allowed roots", () => {
    assert.throws(
      () => checkRepoRootAllowlist(outsidePath, [allowedRoot]),
      (err: unknown) => {
        assert.ok(err instanceof Error, "Expected an Error instance");
        assert.strictEqual(
          (err as { name: string }).name,
          "ValidationError",
          "Expected a ValidationError",
        );
        assert.ok(
          err.message.includes("not within any allowed root"),
          `Expected 'not within any allowed root' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects a sibling path that shares the allowed root as a string prefix but is not inside it", () => {
    // /tmp/allowed-repos-sibling must NOT pass just because it starts with
    // /tmp/allowed-repos as a raw string — the separator guard must fire.
    assert.throws(
      () => checkRepoRootAllowlist(siblingTrickPath, [allowedRoot]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
