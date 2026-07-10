import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildExternalRepoConfig,
  loadExternalRepoSpecs,
} from "../../scripts/setup-external-benchmark-repos.ts";

describe("setup external benchmark repos", () => {
  it("loads pinned specs from the matrix lockfile", () => {
    const specs = loadExternalRepoSpecs();

    assert.deepStrictEqual(
      specs.map((spec) => spec.repoId).sort(),
      ["ansible-lint-oss", "flask-oss", "preact-oss", "scip-io", "zod-oss"],
    );
    assert.deepStrictEqual(
      specs.find((spec) => spec.repoId === "scip-io"),
      {
        repoId: "scip-io",
        cloneUrl: "https://github.com/GlitterKill/scip-io.git",
        ref: "2c6d43c9a82b1f1ddfb36f3d04776994e585bfbd",
        languages: ["rs", "ts"],
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/target/**",
          "**/coverage/**",
        ],
      },
    );
    assert.ok(
      specs.every((spec) => typeof spec.ref === "string" && spec.ref.length >= 7),
      "specs must preserve pinned refs",
    );
  });

  it("builds relative config entries with normalized paths", () => {
    const specs = loadExternalRepoSpecs();
    const payload = buildExternalRepoConfig(".tmp/external-benchmarks", specs);

    assert.strictEqual(payload.repos.length, 5);
    assert.strictEqual(
      payload.repos.find((repo) => repo.repoId === "scip-io")?.rootPath,
      ".tmp/external-benchmarks/scip-io",
    );
    assert.ok(
      payload.repos.every((repo) => !/^[A-Za-z]:\//.test(repo.rootPath)),
      "config paths must not be drive-absolute",
    );
    assert.ok(
      payload.repos.every((repo) => repo.rootPath.includes("/")),
      "config paths should be normalized for cross-platform use",
    );
    assert.ok(
      payload.repos.every((repo) => Array.isArray(repo.languages) && repo.languages.length > 0),
      "config entries should include language metadata",
    );
  });
});
