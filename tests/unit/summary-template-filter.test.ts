import { test } from "node:test";
import assert from "node:assert/strict";

import { isMetadataProseTemplate } from "../../dist/indexer/summaries.js";

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
