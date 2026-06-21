import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatProviderFirstAutoFallbackReason } from "../../dist/indexer/indexer.js";

const emptyFactsReason =
  "index phase providerFirstScipIncremental failed: Provider-first SCIP execution produced no file facts. Diagnostics: empty_index";

describe("formatProviderFirstAutoFallbackReason", () => {
  it("downgrades empty incremental provider output to fallback wording", () => {
    assert.equal(
      formatProviderFirstAutoFallbackReason({
        reason: emptyFactsReason,
        providerFirstIncrementalActive: true,
      }),
      "provider-first incremental produced no provider facts for selected changed files; using legacy fallback",
    );
  });

  it("keeps empty provider output unchanged outside incremental mode", () => {
    assert.equal(
      formatProviderFirstAutoFallbackReason({
        reason: emptyFactsReason,
        providerFirstIncrementalActive: false,
      }),
      emptyFactsReason,
    );
  });

  it("keeps real provider execution failures unchanged", () => {
    const reason = "index phase providerFirstScipIncremental failed: spawn ENOENT";

    assert.equal(
      formatProviderFirstAutoFallbackReason({
        reason,
        providerFirstIncrementalActive: true,
      }),
      reason,
    );
  });
});
