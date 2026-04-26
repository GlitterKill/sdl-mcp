// Extract pure fusion/evidence helpers from src/retrieval/orchestrator.ts
// into src/retrieval/fusion.ts. Plan Phase 3 (partial — sources.ts deferred).
import fs from "node:fs";

const ORCH = "src/retrieval/orchestrator.ts";
const FUSION = "src/retrieval/fusion.ts";

const src = fs.readFileSync(ORCH, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

const findStarts = (predicate) =>
  lines.reduce((acc, l, i) => {
    if (predicate(l)) acc.push(i);
    return acc;
  }, []);

const findFirst = (prefix, fromIdx = 0) => {
  for (let i = fromIdx; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) return i;
  }
  return -1;
};

const idxSourceRanking = findFirst("interface SourceRanking");
const idxDefaultRrfK = findFirst("const DEFAULT_RRF_K");
const idxRrfFuse = findFirst("function rrfFuse(");
const idxBuildEvidence = findFirst("function buildEvidence(");
const idxResolveConfig = findFirst("function resolveConfig(");
const idxEntitySourceRanking = findFirst("interface EntitySourceRanking");
const idxRrfFuseEntities = findFirst("function rrfFuseEntities(");
const idxBuildEntityEvidence = findFirst("function buildEntityEvidence(");
const idxEntitySearch = findFirst("export async function entitySearch");

const required = {
  idxSourceRanking,
  idxDefaultRrfK,
  idxRrfFuse,
  idxBuildEvidence,
  idxResolveConfig,
  idxEntitySourceRanking,
  idxRrfFuseEntities,
  idxBuildEntityEvidence,
  idxEntitySearch,
};
for (const [k, v] of Object.entries(required)) {
  if (v < 0) {
    console.error("Anchor missing:", k);
    process.exit(1);
  }
}

const sliceLines = (start, end) => lines.slice(start, end);
const trimTrailingBlanks = (arr) => {
  let e = arr.length;
  while (e > 0 && arr[e - 1].trim() === "") e--;
  return arr.slice(0, e);
};

const blockSourceRanking = trimTrailingBlanks(
  sliceLines(idxSourceRanking, idxDefaultRrfK),
);
const blockDefaultRrfK = trimTrailingBlanks(
  sliceLines(idxDefaultRrfK, idxDefaultRrfK + 1),
);
const blockRrfFuse = trimTrailingBlanks(
  sliceLines(idxRrfFuse, idxBuildEvidence),
);
const blockBuildEvidence = trimTrailingBlanks(
  sliceLines(idxBuildEvidence, idxResolveConfig),
);
const blockEntitySourceRanking = trimTrailingBlanks(
  sliceLines(idxEntitySourceRanking, idxRrfFuseEntities),
);
const blockRrfFuseEntities = trimTrailingBlanks(
  sliceLines(idxRrfFuseEntities, idxBuildEntityEvidence),
);
const blockBuildEntityEvidence = trimTrailingBlanks(
  sliceLines(idxBuildEntityEvidence, idxEntitySearch),
);

const fusionHeader = [
  "// =============================================================================",
  "// retrieval/fusion.ts \u2014 Pure RRF fusion + evidence builders.",
  "//",
  "// Public exports:",
  "//   Symbol-level:",
  "//     - SourceRanking, DEFAULT_RRF_K",
  "//     - rrfFuse(rankings, k?, candidateLimit?) \u2014 reciprocal-rank fusion",
  "//     - buildEvidence(rankings, fused, fusionLatencyMs, fallbackReason?) \u2014 evidence shape",
  "//   Entity-level:",
  "//     - EntitySourceRanking",
  "//     - rrfFuseEntities(...)",
  "//     - buildEntityEvidence(...)",
  "//",
  "// Extracted from retrieval/orchestrator.ts. All helpers are pure (no I/O).",
  "// =============================================================================",
  "",
  'import type { RetrievalSource, RetrievalEvidence } from "./types.js";',
  'import type { SearchResultItem, EntitySearchResultItem } from "./entity-types.js";',
  "",
];

// Promote internal `function` / `interface` to `export`.
const toExported = (block) =>
  block.map((line, i) => {
    if (i !== 0) return line;
    if (line.startsWith("export ")) return line;
    if (
      line.startsWith("function ") ||
      line.startsWith("async function ") ||
      line.startsWith("interface ") ||
      line.startsWith("const ") ||
      line.startsWith("type ")
    ) {
      return "export " + line;
    }
    return line;
  });

const fusionContent = [
  ...fusionHeader,
  ...toExported(blockSourceRanking),
  "",
  ...toExported(blockDefaultRrfK),
  "",
  ...toExported(blockRrfFuse),
  "",
  ...toExported(blockBuildEvidence),
  "",
  ...toExported(blockEntitySourceRanking),
  "",
  ...toExported(blockRrfFuseEntities),
  "",
  ...toExported(blockBuildEntityEvidence),
  "",
].join(eol);

fs.writeFileSync(FUSION, fusionContent, "utf8");
console.log(`Wrote ${FUSION} (${fusionContent.split(/\r?\n/).length} lines)`);

// Now rewrite orchestrator.ts: remove the moved blocks, add an import line.
// We must preserve order since we're slicing by index. Easiest: build a list
// of [startLine, endExclusive] ranges to drop, then filter lines.
const dropRanges = [
  [idxSourceRanking, idxDefaultRrfK + 1], // SourceRanking + DEFAULT_RRF_K (single line consts adjacent)
  [idxRrfFuse, idxBuildEvidence],
  [idxBuildEvidence, idxResolveConfig],
  [idxEntitySourceRanking, idxRrfFuseEntities],
  [idxRrfFuseEntities, idxBuildEntityEvidence],
  [idxBuildEntityEvidence, idxEntitySearch],
];

// Sort and merge contiguous ranges (sanity).
dropRanges.sort((a, b) => a[0] - b[0]);
const merged = [];
for (const r of dropRanges) {
  if (merged.length && r[0] <= merged[merged.length - 1][1]) {
    merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
  } else {
    merged.push([...r]);
  }
}

const dropSet = new Set();
for (const [s, e] of merged) {
  for (let i = s; i < e; i++) dropSet.add(i);
}

const kept = lines.filter((_l, i) => !dropSet.has(i));

// Inject import line after last existing top-of-file import (within first 80 lines).
let lastImportIdx = -1;
for (let i = 0; i < Math.min(80, kept.length); i++) {
  if (kept[i].startsWith("import ")) lastImportIdx = i;
}
if (lastImportIdx < 0) {
  console.error("No imports found in orchestrator.ts");
  process.exit(1);
}

const newImport =
  `import {${eol}` +
  `  type SourceRanking,${eol}` +
  `  type EntitySourceRanking,${eol}` +
  `  DEFAULT_RRF_K,${eol}` +
  `  rrfFuse,${eol}` +
  `  buildEvidence,${eol}` +
  `  rrfFuseEntities,${eol}` +
  `  buildEntityEvidence,${eol}` +
  `} from "./fusion.js";`;

const final = [
  ...kept.slice(0, lastImportIdx + 1),
  newImport,
  ...kept.slice(lastImportIdx + 1),
];

fs.writeFileSync(ORCH, final.join(eol), "utf8");
console.log(`Wrote ${ORCH} (${final.length} lines)`);
