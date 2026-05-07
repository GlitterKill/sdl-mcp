import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePostIndexSessionTimeoutMs,
} from "../../dist/indexer/indexer.js";
import type { RepoConfig } from "../../dist/config/types.js";

function repoConfig(
  repoId: string,
  postIndexSessionTimeoutMs?: number,
): RepoConfig {
  return {
    repoId,
    rootPath: `/tmp/${repoId}`,
    ignore: [],
    languages: ["ts"],
    maxFileBytes: 1_000_000,
    includeNodeModulesTypes: true,
    packageJsonPath: null,
    tsconfigPath: null,
    workspaceGlobs: null,
    ...(postIndexSessionTimeoutMs !== undefined
      ? { postIndexSessionTimeoutMs }
      : {}),
  };
}

describe("indexer repo config resolution", () => {
  it("prefers the live config timeout over the stored repo config", () => {
    const timeoutMs = resolvePostIndexSessionTimeoutMs(
      "target",
      [repoConfig("target", 1_800_000)],
      repoConfig("target", 900_000),
    );

    assert.equal(timeoutMs, 1_800_000);
  });

  it("falls back to the stored repo config when the live config has no match", () => {
    const timeoutMs = resolvePostIndexSessionTimeoutMs(
      "target",
      [repoConfig("other", 1_800_000)],
      repoConfig("target", 900_000),
    );

    assert.equal(timeoutMs, 900_000);
  });

  it("leaves timeout undefined when neither config source sets one", () => {
    const timeoutMs = resolvePostIndexSessionTimeoutMs(
      "target",
      [repoConfig("target")],
      repoConfig("target"),
    );

    assert.equal(timeoutMs, undefined);
  });
});
