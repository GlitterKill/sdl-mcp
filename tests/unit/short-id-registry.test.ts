import { test } from "node:test";
import assert from "node:assert/strict";

import { ShortIdRegistry } from "../../dist/mcp/short-id-registry.js";

test("assigns sequential aliases per session and is idempotent", () => {
  const reg = new ShortIdRegistry();
  assert.equal(reg.alias("sess", "aaaa"), "s1");
  assert.equal(reg.alias("sess", "bbbb"), "s2");
  assert.equal(reg.alias("sess", "aaaa"), "s1");
});

test("reports only newly introduced aliases", () => {
  const reg = new ShortIdRegistry();
  assert.deepEqual(reg.aliasWithStatus("sess", "aaaa"), { alias: "s1", introduced: true });
  assert.deepEqual(reg.aliasWithStatus("sess", "aaaa"), { alias: "s1", introduced: false });
});

test("resolves aliases and passes through full ids", () => {
  const reg = new ShortIdRegistry();
  reg.alias("sess", "aaaa");
  assert.equal(reg.resolve("sess", "s1"), "aaaa");
  assert.equal(reg.resolve("sess", "aaaa"), "aaaa");
  assert.equal(reg.resolve("sess", "s99"), undefined);
  assert.equal(reg.resolve("other", "s1"), undefined);
});

test("looksLikeAlias distinguishes aliases from 64-hex ids", () => {
  assert.equal(ShortIdRegistry.looksLikeAlias("s1"), true);
  assert.equal(ShortIdRegistry.looksLikeAlias("s123"), true);
  assert.equal(ShortIdRegistry.looksLikeAlias("3c6e44f4"), false);
  assert.equal(ShortIdRegistry.looksLikeAlias("summary"), false);
});

test("entry cap drops the session without reusing aliases", () => {
  const reg = new ShortIdRegistry({ maxEntriesPerSession: 1 });
  assert.equal(reg.alias("sess", "aaaa"), "s1");
  assert.equal(reg.alias("sess", "bbbb"), "bbbb");
  assert.equal(reg.resolve("sess", "s1"), undefined);
  assert.equal(reg.alias("sess", "cccc"), "cccc");
  assert.equal(reg.resolve("sess", "s1"), undefined);
});

test("markDelivered tracks delivered aliases per session", () => {
  const reg = new ShortIdRegistry();
  const alias = reg.alias("sess", "abcd1234");
  assert.equal(reg.isDelivered("sess", alias), false);
  reg.markDelivered("sess", [alias]);
  assert.equal(reg.isDelivered("sess", alias), true);
  assert.equal(reg.isDelivered("other", alias), false);
});
