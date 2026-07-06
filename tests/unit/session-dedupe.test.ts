import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionContentLedger } from "../../dist/mcp/session-dedupe.js";

test("first delivery is new, second is unchanged, changed content is changed", () => {
  const ledger = new SessionContentLedger();
  const r1 = ledger.record({
    sessionId: "s",
    key: "card:repo:abc",
    contentHash: "h1",
    etag: "e1",
  });
  assert.equal(r1.status, "new");
  const r2 = ledger.record({
    sessionId: "s",
    key: "card:repo:abc",
    contentHash: "h1",
    etag: "e1",
  });
  assert.equal(r2.status, "unchanged");
  const r3 = ledger.record({
    sessionId: "s",
    key: "card:repo:abc",
    contentHash: "h2",
    etag: "e2",
  });
  assert.equal(r3.status, "changed");
});

test("sessions are isolated", () => {
  const ledger = new SessionContentLedger();
  ledger.record({ sessionId: "a", key: "k", contentHash: "h", etag: "e" });
  const r = ledger.record({
    sessionId: "b",
    key: "k",
    contentHash: "h",
    etag: "e",
  });
  assert.equal(r.status, "new");
});

test("missing sessionId bypasses (status new every time)", () => {
  const ledger = new SessionContentLedger();
  assert.equal(ledger.record({ key: "k", contentHash: "h" }).status, "new");
  assert.equal(ledger.record({ key: "k", contentHash: "h" }).status, "new");
});

test("entry cap evicts oldest key", () => {
  const ledger = new SessionContentLedger({ maxEntriesPerSession: 2 });
  ledger.record({ sessionId: "s", key: "k1", contentHash: "h" });
  ledger.record({ sessionId: "s", key: "k2", contentHash: "h" });
  ledger.record({ sessionId: "s", key: "k3", contentHash: "h" }); // evicts k1
  assert.equal(
    ledger.record({ sessionId: "s", key: "k1", contentHash: "h" }).status,
    "new",
  );
  assert.equal(
    ledger.record({ sessionId: "s", key: "k2", contentHash: "h" }).status,
    "unchanged",
  );
});
