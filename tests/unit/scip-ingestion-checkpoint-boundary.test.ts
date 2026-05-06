import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const repoRoot = process.cwd();

describe("SCIP ingestion checkpoint boundary", () => {
  test("does not run manual LadybugDB checkpoints inside the document loop", () => {
    const source = readFileSync(
      join(repoRoot, "src", "scip", "ingestion.ts"),
      "utf8",
    );
    const documentLoopStart = source.indexOf(
      "for await (const doc of decoder.documents())",
    );
    const finalProgressStart = source.indexOf(
      "// Final tick after the last document",
    );
    const documentLoopBody = source.slice(documentLoopStart, finalProgressStart);

    assert.notEqual(
      documentLoopStart,
      -1,
      "test guard could not find the SCIP document loop",
    );
    assert.notEqual(
      finalProgressStart,
      -1,
      "test guard could not find the end of the SCIP document loop",
    );
    assert.equal(
      documentLoopBody.includes("preIndexCheckpoint"),
      false,
      "manual checkpoints can overlap later SCIP DB work and crash LadybugDB",
    );
  });
});
