#!/usr/bin/env node

/**
 * Bench packed vs compact-v3 on saved GraphSlice fixtures. Prints a
 * comparison table and runs the two-axis gate to show which axis fires.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toCompactGraphSliceV3 } from "../dist/mcp/tools/slice-wire-format.js";
import {
  encodePackedSlice,
  decideFormatDetailed,
} from "../dist/mcp/wire/packed/index.js";
import {
  estimateTokens,
  estimatePackedTokens,
} from "../dist/util/tokenize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "slice-fixtures");

const pct = (n) => (n * 100).toFixed(1) + "%";
const pad = (s, w) => {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
};
const lpad = (s, w) => {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
};

const files = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
if (files.length === 0) {
  console.error(`No fixtures in ${FIXTURE_DIR}.`);
  process.exit(1);
}

console.log(
  "# Packed vs Compact-v3 — wire format size comparison (token-aware gate)\n",
);
console.log(
  "| scenario               | cards | edges | compact B | packed B | bytes% | compact tok | packed tok | tokens% | gate decision |",
);
console.log(
  "|------------------------|-------|-------|-----------|----------|--------|-------------|------------|---------|---------------|",
);

const agg = { cb: 0, pb: 0, ct: 0, pt: 0, packedHits: 0, fallback: 0 };
for (const f of files) {
  const slice = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8"));
  const compact = toCompactGraphSliceV3(slice);
  const compactJson = JSON.stringify(compact);
  const packed = encodePackedSlice(slice);
  const cb = compactJson.length;
  const pb = packed.length;
  const ct = estimateTokens(compactJson);
  const pt = estimatePackedTokens(packed);
  const result = decideFormatDetailed(
    "packed",
    { jsonBytes: cb, packedBytes: pb, jsonTokens: ct, packedTokens: pt },
    0.15,
    0.3,
  );
  const decision =
    result.decision === "packed"
      ? "packed (" + result.axisHit + ")"
      : "fallback";
  if (result.decision === "packed") agg.packedHits++;
  else agg.fallback++;
  agg.cb += cb;
  agg.pb += pb;
  agg.ct += ct;
  agg.pt += pt;
  const label = f.replace(/\.json$/, "");
  console.log(
    `| ${lpad(label, 22)} | ${pad(slice.cards.length, 5)} | ${pad(slice.edges?.length ?? 0, 5)} | ${pad(cb, 9)} | ${pad(pb, 8)} | ${pad(pct((cb - pb) / cb), 6)} | ${pad(ct, 11)} | ${pad(pt, 10)} | ${pad(pct((ct - pt) / Math.max(1, ct)), 7)} | ${lpad(decision, 13)} |`,
  );
}

const tsb = agg.cb - agg.pb;
const tst = agg.ct - agg.pt;
console.log(
  `\n**Aggregate** — bytes: compact=${agg.cb} packed=${agg.pb} saved=${tsb} (${pct(tsb / agg.cb)}); tokens: compact=${agg.ct} packed=${agg.pt} saved=${tst} (${pct(tst / Math.max(1, agg.ct))}).`,
);
console.log(
  `Gate hits: ${agg.packedHits}/${files.length} fixtures emit packed (token threshold 0.30, byte threshold 0.15); ${agg.fallback} fall back.`,
);
