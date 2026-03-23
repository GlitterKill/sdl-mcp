import { describe, it } from "node:test";
import assert from "node:assert";
import { resolve } from "path";
import { resolveRepoId, suggestAction } from "../../dist/cli/commands/tool-dispatch.js";

describe("cli-tool-dispatch", () => {
  describe("resolveRepoId", () => {
    it("uses explicit repoId if provided", () => {
      const explicit = "my-explicit-repo";
      const repos = [{ repoId: "configured-repo", rootPath: "/path/to/repo" }];
      assert.strictEqual(resolveRepoId(explicit, repos), "my-explicit-repo");
    });

    it("matches cwd to configured repo root", () => {
      const cwd = process.cwd();
      const repos = [
        { repoId: "other-repo", rootPath: "/some/other/path" },
        { repoId: "cwd-repo", rootPath: cwd },
      ];
      // It should match the second repo because it matches cwd
      assert.strictEqual(resolveRepoId(undefined, repos), "cwd-repo");
    });

    it("matches cwd to a subdirectory of a configured repo", () => {
      const cwd = process.cwd();
      const parentDir = resolve(cwd, "..");
      const repos = [
        { repoId: "parent-repo", rootPath: parentDir },
      ];
      // CWD is a subdirectory of the configured rootPath
      assert.strictEqual(resolveRepoId(undefined, repos), "parent-repo");
    });

    it("falls back to single configured repo if no match", () => {
      const repos = [{ repoId: "single-repo", rootPath: "/non-matching/path" }];
      assert.strictEqual(resolveRepoId(undefined, repos), "single-repo");
    });

    it("returns undefined if multiple repos and no match", () => {
      const repos = [
        { repoId: "repo1", rootPath: "/non/matching/1" },
        { repoId: "repo2", rootPath: "/non/matching/2" },
      ];
      assert.strictEqual(resolveRepoId(undefined, repos), undefined);
    });

    it("returns undefined if no repos configured", () => {
      assert.strictEqual(resolveRepoId(undefined, []), undefined);
    });
  });

  describe("suggestAction", () => {
    it("finds exact prefix matches", () => {
      assert.strictEqual(suggestAction("symbol.sear"), "symbol.search");
      assert.strictEqual(suggestAction("slice.b"), "slice.build");
    });

    it("finds substring matches", () => {
      assert.strictEqual(suggestAction("overview"), "repo.overview");
    });

    it("returns undefined for ambiguous matches", () => {
      assert.strictEqual(suggestAction("symbol"), undefined); // multiple symbol.* actions
    });

    it("returns undefined for no matches", () => {
      assert.strictEqual(suggestAction("does.not.exist"), undefined);
    });
  });
});
