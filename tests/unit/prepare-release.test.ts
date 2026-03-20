import assert from "node:assert";
import { describe, it } from "node:test";

describe("prepare-release helpers", () => {
  it("classifies changelog, native version sync, branch sync, and pack contents", async () => {
    const helpers = await import("../../scripts/prepare-release.mjs");

    assert.strictEqual(
      helpers.hasChangelogEntry("## [0.9.0] - 2026-03-17\n", "0.9.0"),
      true,
    );
    assert.strictEqual(
      helpers.hasChangelogEntry("## [0.8.9] - 2026-03-17\n", "0.9.0"),
      false,
    );

    const mismatches = helpers.findNativeVersionMismatches(
      {
        version: "1.2.3",
        optionalDependencies: { "sdl-mcp-native": "1.2.3" },
      },
      { version: "1.2.3" },
      [{ name: "win32-x64-msvc", version: "1.2.3" }],
    );
    assert.deepStrictEqual(mismatches, []);

    const mismatchResult = helpers.findNativeVersionMismatches(
      {
        version: "1.2.3",
        optionalDependencies: { "sdl-mcp-native": "1.2.2" },
      },
      { version: "1.2.1" },
      [{ name: "win32-x64-msvc", version: "1.2.0" }],
    );
    assert.ok(mismatchResult.length >= 2);

    assert.deepStrictEqual(
      helpers.classifyBranchStatus("main", "## main...origin/main"),
      { nonMainBranch: false, unsynced: false },
    );
    assert.deepStrictEqual(
      helpers.classifyBranchStatus(
        "feature/test",
        "## feature/test...origin/feature/test [ahead 1]",
      ),
      { nonMainBranch: true, unsynced: true },
    );

    assert.deepStrictEqual(
      helpers.findMissingPackEntries(
        helpers.getRequiredPackEntries().map((path) => ({ path })),
      ),
      [],
    );
    assert.ok(
      helpers.findMissingPackEntries([{ path: "package.json" }]).length > 0,
    );
  });
});
