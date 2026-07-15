import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const sourcePath = join(
  process.cwd(),
  "src",
  "live-index",
  "file-patcher.ts",
);

describe("patchSavedFile Symbol FTS lifecycle", () => {
  it("mutates directly without the retired Symbol FTS pause/rebuild wrapper", () => {
    const source = readFileSync(sourcePath, "utf8");

    assert.doesNotMatch(
      source,
      /withSymbolFtsPausedForPatch/u,
      "patchSavedFile must not retain the 0.16.1 Symbol FTS pause wrapper after the 0.18.1 runtime gate is green",
    );
    assert.doesNotMatch(
      source,
      /\bdropFtsIndex\b/u,
      "patchSavedFile must not drop Symbol FTS around a patch mutation",
    );
    assert.doesNotMatch(
      source,
      /\bensureFtsIndexForNonEmptyTable\b/u,
      "patchSavedFile must not rebuild Symbol FTS around a patch mutation",
    );
    assert.match(
      source,
      /await withWriteConn\(async \(wConn\) => \{\s*await ladybugDb\.withTransaction\(wConn, async \(txConn\) => \{/u,
      "patchSavedFile should call the mutation transaction directly inside the write connection",
    );
  });
});
