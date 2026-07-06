import { test } from "node:test";
import assert from "node:assert/strict";

import { isMetadataProseTemplate } from "../../dist/indexer/summaries.js";
import { compactCardForWire } from "../../dist/mcp/tools/symbol-utils.js";

test("catches the live leaked template", () => {
  assert.equal(
    isMetadataProseTemplate(
      "Represents slice build internal result, using available signature, role, path, language, and graph context metadata.",
      "SliceBuildInternalResult",
    ),
    true,
  );
});

test("catches returning-type variant", () => {
  assert.equal(
    isMetadataProseTemplate(
      "Computes foo returning string using available signature, symbol metadata, and graph context details",
      "computeFoo",
    ),
    true,
  );
});

test("does not flag real summaries", () => {
  assert.equal(
    isMetadataProseTemplate(
      "Builds a BFS slice over call edges, stopping at the token budget.",
      "buildSlice",
    ),
    false,
  );
});

test("keeps summaryProvenance when summary survives wire filtering", () => {
  const out = compactCardForWire({
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "buildSlice",
    exported: true,
    range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    summary: "Builds a BFS slice over call edges, stopping at the token budget.",
    summaryProvenance: "heuristic",
  });

  assert.equal(out.summaryProvenance, "heuristic");
});

test("omits summaryProvenance when summary is suppressed", () => {
  const out = compactCardForWire({
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "SliceBuildInternalResult",
    exported: true,
    range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    summary:
      "Represents slice build internal result, using available signature, role, path, language, and graph context metadata.",
    summaryProvenance: "heuristic",
  });

  assert.equal(Object.prototype.hasOwnProperty.call(out, "summary"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(out, "summaryProvenance"),
    false,
  );
});
