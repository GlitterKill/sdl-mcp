import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodePackedSlice,
  decodePacked,
  shouldEmitPacked,
  parseHeader,
  splitSections,
} from "../../dist/mcp/wire/packed/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "../golden/packed-slice-fixture.json");

interface Fixture {
  encoderId: string;
  input: Parameters<typeof encodePackedSlice>[0];
  expected: {
    header: string;
    encoderId: string;
    toolName: string;
    minLegendEntries: number;
    minTableRows: Record<string, number>;
    decodedKeys: string[];
  };
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
}

test("packed golden — sl1 emits stable header for fixture", () => {
  const fx = loadFixture();
  const payload = encodePackedSlice(fx.input);
  const sections = splitSections(payload);
  assert.equal(sections.header, fx.expected.header);
});

test("packed golden — sl1 produces expected legend interning", () => {
  const fx = loadFixture();
  const payload = encodePackedSlice(fx.input);
  const sections = splitSections(payload);
  const legendLines = sections.legend ? sections.legend.split("\n") : [];
  assert.ok(
    legendLines.length >= fx.expected.minLegendEntries,
    `expected at least ${fx.expected.minLegendEntries} legend entries, got ${legendLines.length}`,
  );
  for (const line of legendLines) {
    assert.match(line, /^@\d+=/, `legend entry malformed: ${line}`);
  }
});

test("packed golden — sl1 round-trips through decoder", () => {
  const fx = loadFixture();
  const payload = encodePackedSlice(fx.input);
  const decoded = decodePacked(payload);
  assert.equal(decoded.encoderId, fx.expected.encoderId);
  assert.equal(decoded.toolName, fx.expected.toolName);
  for (const key of fx.expected.decodedKeys) {
    assert.ok(
      key in decoded.data,
      `decoded payload missing expected key '${key}'`,
    );
  }
});

test("packed golden — sl1 row counts match fixture", () => {
  const fx = loadFixture();
  const payload = encodePackedSlice(fx.input);
  const decoded = decodePacked(payload);
  const cards = decoded.data.cards as unknown[] | undefined;
  const edges = decoded.data.edges as unknown[] | undefined;
  assert.equal(
    cards?.length ?? 0,
    fx.expected.minTableRows.c,
    "cards count drift",
  );
  assert.equal(
    edges?.length ?? 0,
    fx.expected.minTableRows.e,
    "edges count drift",
  );
});

test("packed golden — sl1 saves bytes vs JSON for representative slice", () => {
  const fx = loadFixture();
  const jsonStr = JSON.stringify(fx.input);
  const packedStr = encodePackedSlice(fx.input);
  const ratio = (jsonStr.length - packedStr.length) / jsonStr.length;
  assert.ok(
    ratio >= 0.15,
    `Expected ≥0.15 savings on fixture, got ${ratio.toFixed(3)} (jsonBytes=${jsonStr.length}, packedBytes=${packedStr.length})`,
  );
  assert.ok(
    shouldEmitPacked(jsonStr.length, packedStr.length, 0.15),
    "fixture should clear the default 0.15 gate threshold",
  );
});

test("packed golden — sl1 header parses to expected metadata", () => {
  const fx = loadFixture();
  const payload = encodePackedSlice(fx.input);
  const sections = splitSections(payload);
  const header = parseHeader(sections.header);
  assert.equal(header.version, 1);
  assert.equal(header.toolName, "slice.build");
  assert.equal(header.encoderId, "sl1");
});
