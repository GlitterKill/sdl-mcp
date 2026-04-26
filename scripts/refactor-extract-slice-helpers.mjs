// Phase 5: extract pure-ish helpers from src/graph/slice.ts into 4 sibling files.
//   - src/graph/slice/types.ts          <- SliceBuildInternalResult + SliceBuildRequest (shared)
//   - src/graph/slice/detail-level.ts   <- resolveEffectiveDetailLevel + buildDetailLevelMetadata + buildCallResolution
//   - src/graph/slice/card-hydrator.ts  <- loadSymbolCards
//   - src/graph/slice/edge-projector.ts <- SliceEdgeProjection + buildSliceDepsBySymbol + loadEdgesBetweenSymbols
//
// Status-only output -- never echoes source.
import fs from "node:fs";

const SRC = "src/graph/slice.ts";
const NEW_TYPES = "src/graph/slice/types.ts";
const NEW_DETAIL = "src/graph/slice/detail-level.ts";
const NEW_CARD = "src/graph/slice/card-hydrator.ts";
const NEW_EDGE = "src/graph/slice/edge-projector.ts";

const src = fs.readFileSync(SRC, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

const findFirst = (pattern) => {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
};

const idxSliceInternalResult = findFirst(
  /^export interface SliceBuildInternalResult /,
);
const idxSliceBuildRequest = findFirst(/^interface SliceBuildRequest /);
const idxBuildSlice = findFirst(/^export async function buildSlice\(/);
const idxResolveDetail = findFirst(/^function resolveEffectiveDetailLevel\(/);
const idxBuildDetailMeta = findFirst(/^function buildDetailLevelMetadata\(/);
const idxBuildCallRes = findFirst(/^function buildCallResolution\(/);
const idxLoadCards = findFirst(/^async function loadSymbolCards\(/);
const idxSliceEdgeType = findFirst(/^type SliceEdgeProjection /);
const idxBuildDeps = findFirst(/^async function buildSliceDepsBySymbol\(/);
const idxLoadEdges = findFirst(/^async function loadEdgesBetweenSymbols\(/);
const idxBuildSliceWithResult = findFirst(
  /^export async function buildSliceWithResult\(/,
);

const required = {
  idxSliceInternalResult,
  idxSliceBuildRequest,
  idxBuildSlice,
  idxResolveDetail,
  idxBuildDetailMeta,
  idxBuildCallRes,
  idxLoadCards,
  idxSliceEdgeType,
  idxBuildDeps,
  idxLoadEdges,
  idxBuildSliceWithResult,
};
for (const [k, v] of Object.entries(required)) {
  if (v < 0) {
    console.error("Anchor missing:", k);
    process.exit(1);
  }
}

const trimTrailingBlanks = (arr) => {
  let e = arr.length;
  while (e > 0 && arr[e - 1].trim() === "") e--;
  return arr.slice(0, e);
};
const sliceLinesArr = (s, e) => trimTrailingBlanks(lines.slice(s, e));

const typesBlock = sliceLinesArr(idxSliceInternalResult, idxBuildSlice);
const detailBlock = sliceLinesArr(idxResolveDetail, idxLoadCards);
const cardBlock = sliceLinesArr(idxLoadCards, idxSliceEdgeType);
const edgeBlock = sliceLinesArr(idxSliceEdgeType, idxBuildSliceWithResult);

const promoteExports = (block) =>
  block.map((line) => {
    if (
      /^(function |async function |interface |type |const )/.test(line) &&
      !line.startsWith("export ")
    ) {
      return "export " + line;
    }
    return line;
  });

// ---- Parse imports from text via regex (handles multi-line) ----
const importRegex =
  /^import\s+(type\s+)?(?:(\*\s+as\s+\w+)|(\{[\s\S]*?\})|(\w+))\s+from\s+"([^"]+)";$/gm;

const parseImports = (text) => {
  const records = [];
  let m;
  while ((m = importRegex.exec(text)) !== null) {
    const isType = !!m[1];
    const star = m[2];
    const namedRaw = m[3];
    const def = m[4];
    const source = m[5];
    let kind, names;
    if (star) {
      kind = "star";
      const sm = star.match(/\*\s+as\s+(\w+)/);
      names = [{ original: "*", alias: sm[1], typeOnly: false }];
    } else if (namedRaw) {
      kind = "named";
      names = namedRaw
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const typeOnly = /^type\s+/.test(s);
          const cleaned = s.replace(/^type\s+/, "");
          const parts = cleaned.split(/\s+as\s+/);
          return {
            original: parts[0].trim(),
            alias: (parts[1] || parts[0]).trim(),
            typeOnly,
          };
        });
    } else if (def) {
      kind = "default";
      names = [{ original: "default", alias: def, typeOnly: false }];
    } else {
      continue;
    }
    records.push({ raw: m[0], isType, source, kind, names });
  }
  return records;
};

const headerImports = parseImports(
  lines.slice(0, idxSliceInternalResult).join("\n"),
);

const rewriteSpecForSubdir = (spec) => {
  if (!spec.startsWith(".")) return spec;
  if (spec.startsWith("./")) return "../" + spec.slice(2);
  if (spec.startsWith("../")) return "../" + spec;
  return spec;
};

const collectUsedIdentifiers = (text) => {
  const used = new Set();
  const re = /\b([A-Za-z_$][\w$]*)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) used.add(m[1]);
  return used;
};

const renderImport = (rec, specifier) => {
  if (rec.kind === "star") {
    const alias = rec.names[0].alias;
    return `import ${rec.isType ? "type " : ""}* as ${alias} from "${specifier}";`;
  }
  if (rec.kind === "default") {
    const alias = rec.names[0].alias;
    return `import ${rec.isType ? "type " : ""}${alias} from "${specifier}";`;
  }
  const partsRendered = rec.names.map((n) => {
    const aliasPart =
      n.original === n.alias ? n.original : `${n.original} as ${n.alias}`;
    return n.typeOnly ? `type ${aliasPart}` : aliasPart;
  });
  return `import ${rec.isType ? "type " : ""}{ ${partsRendered.join(", ")} } from "${specifier}";`;
};

const filterImportsForBlock = (records, body, rewriteSpec) => {
  const used = collectUsedIdentifiers(body.join("\n"));
  const out = [];
  for (const rec of records) {
    const newSpec = rewriteSpec ? rewriteSpecForSubdir(rec.source) : rec.source;
    if (rec.kind === "star" || rec.kind === "default") {
      if (used.has(rec.names[0].alias)) {
        out.push(renderImport(rec, newSpec));
      }
    } else {
      const kept = rec.names.filter((n) => used.has(n.alias));
      if (kept.length === 0) continue;
      out.push(renderImport({ ...rec, names: kept }, newSpec));
    }
  }
  return out;
};

const CROSS_MODULE_SYMBOLS = {
  "./types.js": ["SliceBuildInternalResult", "SliceBuildRequest"],
  "./detail-level.js": [
    "resolveEffectiveDetailLevel",
    "buildDetailLevelMetadata",
    "buildCallResolution",
  ],
  "./card-hydrator.js": ["loadSymbolCards"],
  "./edge-projector.js": [
    "SliceEdgeProjection",
    "buildSliceDepsBySymbol",
    "loadEdgesBetweenSymbols",
  ],
};
const TYPE_ONLY_NAMES = new Set([
  "SliceBuildInternalResult",
  "SliceBuildRequest",
  "SliceEdgeProjection",
]);

const buildCrossModuleImports = (selfPath, body) => {
  const used = collectUsedIdentifiers(body.join("\n"));
  const out = [];
  for (const [modPath, symbols] of Object.entries(CROSS_MODULE_SYMBOLS)) {
    if (modPath === selfPath) continue;
    const needed = symbols.filter((s) => used.has(s));
    if (needed.length === 0) continue;
    const allTypes = needed.every((n) => TYPE_ONLY_NAMES.has(n));
    if (allTypes) {
      out.push(`import type { ${needed.join(", ")} } from "${modPath}";`);
    } else {
      const partsRendered = needed.map((n) =>
        TYPE_ONLY_NAMES.has(n) ? `type ${n}` : n,
      );
      out.push(`import { ${partsRendered.join(", ")} } from "${modPath}";`);
    }
  }
  return out;
};

const HEADER_TYPES = [
  "// =============================================================================",
  "// graph/slice/types.ts \u2014 Internal slice-builder request/result types.",
  "//",
  "// Public exports:",
  "//   - SliceBuildInternalResult",
  "//   - SliceBuildRequest",
  "// =============================================================================",
  "",
];
const HEADER_DETAIL = [
  "// =============================================================================",
  "// graph/slice/detail-level.ts \u2014 Detail-level resolution + metadata builders.",
  "//",
  "// Public exports:",
  "//   - resolveEffectiveDetailLevel(...)",
  "//   - buildDetailLevelMetadata(...)",
  "//   - buildCallResolution(...)",
  "// =============================================================================",
  "",
];
const HEADER_CARD = [
  "// =============================================================================",
  "// graph/slice/card-hydrator.ts \u2014 Symbol-card hydration for slice builder.",
  "//",
  "// Public exports:",
  "//   - loadSymbolCards(...)",
  "// =============================================================================",
  "",
];
const HEADER_EDGE = [
  "// =============================================================================",
  "// graph/slice/edge-projector.ts \u2014 Slice edge projection + dependency mapping.",
  "//",
  "// Public exports:",
  "//   - SliceEdgeProjection",
  "//   - buildSliceDepsBySymbol(...)",
  "//   - loadEdgesBetweenSymbols(...)",
  "// =============================================================================",
  "",
];

const writeModule = (path, header, importLines, body) => {
  const promoted = promoteExports(body);
  const importBlock = importLines.length
    ? importLines.join(eol) + eol + eol
    : "";
  const content =
    header.join(eol) + eol + importBlock + promoted.join(eol) + eol;
  fs.writeFileSync(path, content, "utf8");
  console.log(`wrote ${path} (${content.split(/\r?\n/).length} lines)`);
};

{
  const fromHeader = filterImportsForBlock(headerImports, typesBlock, true);
  const cross = buildCrossModuleImports("./types.js", typesBlock);
  writeModule(NEW_TYPES, HEADER_TYPES, [...fromHeader, ...cross], typesBlock);
}
{
  const fromHeader = filterImportsForBlock(headerImports, detailBlock, true);
  const cross = buildCrossModuleImports("./detail-level.js", detailBlock);
  writeModule(
    NEW_DETAIL,
    HEADER_DETAIL,
    [...fromHeader, ...cross],
    detailBlock,
  );
}
{
  const fromHeader = filterImportsForBlock(headerImports, cardBlock, true);
  const cross = buildCrossModuleImports("./card-hydrator.js", cardBlock);
  writeModule(NEW_CARD, HEADER_CARD, [...fromHeader, ...cross], cardBlock);
}
{
  const fromHeader = filterImportsForBlock(headerImports, edgeBlock, true);
  const cross = buildCrossModuleImports("./edge-projector.js", edgeBlock);
  writeModule(NEW_EDGE, HEADER_EDGE, [...fromHeader, ...cross], edgeBlock);
}

// ---- Rewrite slice.ts ----
const dropSet = new Set();
for (let i = idxSliceInternalResult; i < idxBuildSlice; i++) dropSet.add(i);
for (let i = idxResolveDetail; i < idxBuildSliceWithResult; i++) dropSet.add(i);

const keptInitial = lines.filter((_l, i) => !dropSet.has(i));

// Detect ALL import ranges in keptInitial (single + multi-line).
const importRangesInKept = [];
{
  let i = 0;
  while (i < keptInitial.length) {
    const l = keptInitial[i];
    if (l.startsWith("import ") && /from\s+"[^"]+";\s*$/.test(l)) {
      importRangesInKept.push({ start: i, end: i + 1 });
      i++;
      continue;
    }
    if (l.startsWith("import ") && !/from\s+"[^"]+";\s*$/.test(l)) {
      const start = i;
      i++;
      while (
        i < keptInitial.length &&
        !/^\s*\}\s+from\s+"[^"]+";\s*$/.test(keptInitial[i])
      ) {
        i++;
      }
      if (i < keptInitial.length) i++;
      importRangesInKept.push({ start, end: i });
      continue;
    }
    i++;
  }
}

// Body lines = everything outside all import ranges.
const isImportLine = new Set();
for (const r of importRangesInKept) {
  for (let i = r.start; i < r.end; i++) isImportLine.add(i);
}
const bodyForUsage = keptInitial
  .filter((_l, i) => !isImportLine.has(i))
  .join("\n");
const usedInBody = collectUsedIdentifiers(bodyForUsage);

const rebuildImport = (range) => {
  const text = keptInitial.slice(range.start, range.end).join("\n");
  const recs = parseImports(text);
  if (recs.length !== 1) return text;
  const rec = recs[0];
  if (rec.kind === "star" || rec.kind === "default") {
    return usedInBody.has(rec.names[0].alias)
      ? renderImport(rec, rec.source)
      : null;
  }
  const kept = rec.names.filter((n) => usedInBody.has(n.alias));
  if (kept.length === 0) return null;
  return renderImport({ ...rec, names: kept }, rec.source);
};

// Build new line array by replacing each import range with its filtered form.
const newLines = [];
let cursor = 0;
for (const range of importRangesInKept) {
  for (let i = cursor; i < range.start; i++) newLines.push(keptInitial[i]);
  const rebuilt = rebuildImport(range);
  if (rebuilt !== null) newLines.push(rebuilt);
  cursor = range.end;
}
for (let i = cursor; i < keptInitial.length; i++) newLines.push(keptInitial[i]);

// Build sibling imports trimmed to names actually used in body.
const newSiblingImports = (() => {
  const out = [];
  const want = (name) => usedInBody.has(name);
  const typeNames = ["SliceBuildInternalResult", "SliceBuildRequest"].filter(
    want,
  );
  if (typeNames.length) {
    out.push(`import {`);
    for (const n of typeNames) out.push(`  type ${n},`);
    out.push(`} from "./slice/types.js";`);
  }
  const detailNames = [
    "resolveEffectiveDetailLevel",
    "buildDetailLevelMetadata",
    "buildCallResolution",
  ].filter(want);
  if (detailNames.length) {
    out.push(`import {`);
    for (const n of detailNames) out.push(`  ${n},`);
    out.push(`} from "./slice/detail-level.js";`);
  }
  if (want("loadSymbolCards")) {
    out.push(`import { loadSymbolCards } from "./slice/card-hydrator.js";`);
  }
  const edgeEntries = [
    { name: "SliceEdgeProjection", typeOnly: true },
    { name: "buildSliceDepsBySymbol", typeOnly: false },
    { name: "loadEdgesBetweenSymbols", typeOnly: false },
  ].filter((e) => want(e.name));
  if (edgeEntries.length) {
    out.push(`import {`);
    for (const e of edgeEntries)
      out.push(`  ${e.typeOnly ? "type " : ""}${e.name},`);
    out.push(`} from "./slice/edge-projector.js";`);
  }
  return out;
})();

const reExport = `export type { SliceBuildInternalResult } from "./slice/types.js";`;

// Insert sibling + re-export AFTER the last surviving import line in newLines.
let lastImportLineIdx = -1;
for (let i = 0; i < newLines.length; i++) {
  const l = newLines[i];
  if (l.startsWith("import ") && /from\s+"[^"]+";\s*$/.test(l)) {
    lastImportLineIdx = i;
  } else if (/^\s*\}\s+from\s+"[^"]+";\s*$/.test(l)) {
    lastImportLineIdx = i;
  }
}
if (lastImportLineIdx < 0) {
  console.error("No import in kept slice.ts");
  process.exit(1);
}

const finalLines = [
  ...newLines.slice(0, lastImportLineIdx + 1),
  ...newSiblingImports,
  reExport,
  ...newLines.slice(lastImportLineIdx + 1),
];

fs.writeFileSync(SRC, finalLines.join(eol), "utf8");
console.log(`rewrote ${SRC} (${finalLines.length} lines)`);
