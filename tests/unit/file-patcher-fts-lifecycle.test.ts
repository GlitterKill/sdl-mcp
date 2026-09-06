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
      /const publish = async \(wConn:[\s\S]*?await ladybugDb\.withTransaction\(wConn, async \(txConn\) => \{/u,
      "prepared publication must retain the mutation transaction",
    );
    assert.match(
      source,
      /if \(writeConn\) await publish\(writeConn\);\s*else await withWriteConn\(publish\);/u,
      "publication must reuse an admitted writer or acquire one",
    );
  });
});
