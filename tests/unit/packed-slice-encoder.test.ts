import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePackedSlice,
  decodePacked,
} from "../../dist/mcp/wire/packed/index.js";

function makeCard(id: string, file: string, name: string, kind = "function") {
  return {
    symbolId: id,
    repoId: "test",
    file,
    range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
    kind,
    name,
    exported: true,
    deps: { imports: [], calls: [] },
    detailLevel: "full",
    version: { ledgerVersion: "v1", astFingerprint: "ab" },
    etag: "et" + id,
    summary: "summary for " + name,
  };
}

function makeSlice(cards: ReturnType<typeof makeCard>[]) {
  const symbolIndex = cards.map((c) => c.symbolId);
  return {
    repoId: "test",
    versionId: "v1",
    budget: { maxCards: 50, maxEstimatedTokens: 8000 },
    startSymbols: symbolIndex.slice(0, 1),
    symbolIndex,
    cards,
    edges: cards.length > 1 ? [[0, 1, "call", 1]] : [],
  };
}

test("sl1 round-trip — small slice", () => {
  const slice = makeSlice([makeCard("a", "src/a.ts", "alpha")]);
  const payload = encodePackedSlice(slice as never);
  const decoded = decodePacked(payload);
  assert.equal(decoded.encoderId, "sl1");
  assert.equal(decoded.toolName, "slice.build");
  assert.equal(decoded.data.versionId, "v1");
  assert.deepEqual((decoded.data.cards as object[])[0], {
    id: "a",
    f: "src/a.ts",
    k: "function",
    n: "alpha",
    e: true,
    s: "",
    sum: "summary for alpha",
  });
});

test("sl1 round-trip — multi-card with edges", () => {
  const slice = makeSlice([
    makeCard("a", "src/a.ts", "alpha"),
    makeCard("b", "src/b.ts", "beta"),
  ]);
  const payload = encodePackedSlice(slice as never);
  const decoded = decodePacked(payload);
  assert.equal((decoded.data.cards as unknown[]).length, 2);
  assert.equal((decoded.data.edges as unknown[]).length, 1);
  const edge = (decoded.data.edges as Array<Record<string, unknown>>)[0];
  assert.equal(edge.from, "a");
  assert.equal(edge.to, "b");
  assert.equal(edge.type, "call");
});

test("sl1 round-trip — empty slice", () => {
  const slice = makeSlice([]);
  const payload = encodePackedSlice(slice as never);
  const decoded = decodePacked(payload);
  assert.deepEqual(decoded.data.cards ?? [], []);
});

test("sl1 round-trip — long file paths intern via legend", () => {
  const slice = makeSlice([
    makeCard("a", "src/components/widgets/button.ts", "Button"),
    makeCard("b", "src/components/widgets/input.ts", "Input"),
    makeCard("c", "src/components/widgets/label.ts", "Label"),
  ]);
  const payload = encodePackedSlice(slice as never);
  const decoded = decodePacked(payload);
  const cards = decoded.data.cards as Array<Record<string, unknown>>;
  assert.equal(cards[0].f, "src/components/widgets/button.ts");
  assert.equal(cards[1].f, "src/components/widgets/input.ts");
  assert.equal(cards[2].f, "src/components/widgets/label.ts");
  assert.match(payload, /@1=/);
});
