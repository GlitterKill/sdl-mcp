import { test } from "node:test";
import assert from "node:assert/strict";

import { WasteLedger } from "../../dist/mcp/waste-ledger.js";

test("tracks delivered vs referenced per tool", () => {
  const wl = new WasteLedger();
  wl.recordDelivered("sess", "symbol.search", ["id1", "id2", "id3"], 300);
  wl.recordReferenced("sess", ["id2"]);
  const snap = wl.snapshot();
  const row = snap.tools.find((t) => t.tool === "symbol.search");
  assert.equal(row?.deliveredIds, 3);
  assert.equal(row?.referencedIds, 1);
  assert.equal(row?.deliveredTokens, 300);
});

test("referencing an id delivered by two tools credits both", () => {
  const wl = new WasteLedger();
  wl.recordDelivered("sess", "symbol.search", ["id1"], 100);
  wl.recordDelivered("sess", "slice.build", ["id1"], 50);
  wl.recordReferenced("sess", ["id1"]);
  const snap = wl.snapshot();
  assert.equal(snap.tools.find((t) => t.tool === "symbol.search")?.referencedIds, 1);
  assert.equal(snap.tools.find((t) => t.tool === "slice.build")?.referencedIds, 1);
});
