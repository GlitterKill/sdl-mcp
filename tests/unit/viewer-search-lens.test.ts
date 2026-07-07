import assert from "node:assert";
import { describe, it } from "node:test";

import { renderSearchResultsHtml } from "../../dist/ui/viewer/lenses/search.js";

describe("viewer search lens", () => {
  it("renders escaped result rows with symbol identifiers", () => {
    const html = renderSearchResultsHtml([
      { symbolId: "sym:1", name: "build<Graph>", kind: "function", clusterId: "c1", score: 0.75, relPath: "src/a.ts" },
    ]);

    assert.match(html, /data-symbol-id="sym:1"/);
    assert.match(html, /data-cluster-id="c1"/);
    assert.match(html, /build&lt;Graph&gt;/);
    assert.match(html, /function/);
    assert.match(html, /src\/a.ts/);
  });

  it("renders an empty state when there are no results", () => {
    assert.match(renderSearchResultsHtml([]), /No results/);
  });
});
