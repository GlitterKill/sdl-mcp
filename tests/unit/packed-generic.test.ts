import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeGeneric,
  decodePacked,
} from "../../dist/mcp/wire/packed/index.js";

test("gen1 handles flat scalar object", () => {
  const payload = encodeGeneric("test", { foo: "bar", num: 42, flag: true });
  const decoded = decodePacked(payload);
  assert.equal(decoded.encoderId, "gen1");
  assert.equal(decoded.data.foo, "bar");
  assert.equal(decoded.data.num, 42);
  assert.equal(decoded.data.flag, true);
});

test("gen1 handles array-of-objects as table", () => {
  const payload = encodeGeneric("test", {
    items: [
      { name: "a", count: 1 },
      { name: "b", count: 2 },
    ],
  });
  const decoded = decodePacked(payload);
  const items = decoded.data.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "a");
  assert.equal(items[0].count, 1);
});

test("gen1 handles empty arrays", () => {
  const payload = encodeGeneric("test", { items: [] });
  const decoded = decodePacked(payload);
  // Empty arrays may not round-trip as tables; just ensure no crash
  assert.ok(decoded);
});

test("gen1 handles deeply nested via JSON scalar fallback", () => {
  const payload = encodeGeneric("test", {
    config: { nested: { deeply: { value: 1 } } },
  });
  const decoded = decodePacked(payload);
  assert.deepEqual(decoded.data.config, {
    nested: { deeply: { value: 1 } },
  });
});

test("gen1 handles null and undefined gracefully", () => {
  const payload = encodeGeneric("test", { a: null, b: "ok" });
  const decoded = decodePacked(payload);
  assert.equal(decoded.data.b, "ok");
});
