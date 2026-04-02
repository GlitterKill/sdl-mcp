import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
      ["ansible-lint-oss", "flask-oss", "preact-oss", "zod-oss"],
    );
    assert.ok(
      specs.every((spec) => typeof spec.ref === "string" && spec.ref.length >= 7),
      "specs must preserve pinned refs",
    );
  });

  it("builds config entries with normalized paths", () => {
    const baseDir = mkdtempSync(resolve(tmpdir(), "sdl-mcp-benchmark-lock-"));
    const specs = loadExternalRepoSpecs();
    const payload = buildExternalRepoConfig(baseDir, specs);

    assert.strictEqual(payload.repos.length, 4);
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
