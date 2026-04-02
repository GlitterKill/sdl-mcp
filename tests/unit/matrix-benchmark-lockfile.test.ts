import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("matrix benchmark lockfile", () => {
  it("pins every external matrix repository to a concrete ref", () => {
    const lock = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "scripts",
          "benchmark",
          "matrix-external-repos.lock.json",
        ),
        "utf8",
      ),
    ) as {
      repos?: Array<{
        repoId: string;
        ref: string;
      }>;
    };

    const repos = lock.repos ?? [];
    assert.deepStrictEqual(
      repos.map((repo) => repo.repoId).sort(),
      ["ansible-lint-oss", "flask-oss", "preact-oss", "zod-oss"],
    );
    assert.ok(
      repos.every((repo) => typeof repo.ref === "string" && repo.ref.length >= 7),
      "every matrix benchmark repo must include a pinned ref",
    );
  });
});
