import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("phase A benchmark lockfile", () => {
  it("pins at least TS, Python, and tier-3 repos", () => {
    const lock = JSON.parse(
      readFileSync(
        join(process.cwd(), "scripts", "benchmark", "phase-a-benchmark-lock.json"),
        "utf8",
      ),
    ) as {
      repos?: Array<{
        languageFamily: string;
        languageTier: string;
        ref: string;
      }>;
    };

    const repos = lock.repos ?? [];
    assert.ok(repos.length >= 3);
    assert.ok(
      repos.some((repo) => repo.languageFamily === "typescript"),
      "typescript repo must be pinned",
    );
    assert.ok(
      repos.some((repo) => repo.languageFamily === "python"),
      "python repo must be pinned",
    );
    assert.ok(
      repos.some((repo) => repo.languageTier === "tier3"),
      "tier-3 repo must be pinned",
    );
    assert.ok(
      repos.every((repo) => typeof repo.ref === "string" && repo.ref.length >= 7),
      "all repos must include pinned refs",
    );
  });
});
