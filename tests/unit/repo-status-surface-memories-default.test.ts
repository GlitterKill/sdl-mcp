import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * T2: Regression test verifying surfaceMemories defaults to false.
 *
 * The handleRepoStatus handler checks `surfaceMemories === true` (strict),
 * meaning the default value must be `false` to prevent automatic memory
 * surfacing on every status call.
 */
describe("repo.status surfaceMemories default", () => {
  it("surfaceMemories is not required in the request schema", async () => {
    const { RepoStatusRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );
    // Parsing a request without surfaceMemories should succeed
    const result = RepoStatusRequestSchema.safeParse({ repoId: "test-repo" });
    assert.ok(result.success, "request without surfaceMemories should be valid");
  });

  it("surfaceMemories defaults to false when omitted", async () => {
    const { RepoStatusRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );
    const result = RepoStatusRequestSchema.parse({ repoId: "test-repo" });
    assert.strictEqual(
      result.surfaceMemories,
      false,
      "surfaceMemories should default to false, not true",
    );
  });

  it("surfaceMemories=false is accepted", async () => {
    const { RepoStatusRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );
    const result = RepoStatusRequestSchema.safeParse({
      repoId: "test-repo",
      surfaceMemories: false,
    });
    assert.ok(result.success, "surfaceMemories=false should be valid");
    assert.strictEqual(result.data.surfaceMemories, false);
  });

  it("surfaceMemories=true is accepted", async () => {
    const { RepoStatusRequestSchema } = await import(
      "../../dist/mcp/tools.js"
    );
    const result = RepoStatusRequestSchema.safeParse({
      repoId: "test-repo",
      surfaceMemories: true,
    });
    assert.ok(result.success, "surfaceMemories=true should be valid");
    assert.strictEqual(result.data.surfaceMemories, true);
  });
});
