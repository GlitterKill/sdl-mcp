// One-shot extraction script: pulls identifier-extraction helpers out of
// src/agent/executor.ts into src/agent/identifier-extraction.ts.
// Run via: node scripts/refactor-extract-identifiers.mjs
import fs from "node:fs";

const EXEC_PATH = "src/agent/executor.ts";
const NEW_PATH = "src/agent/identifier-extraction.ts";

const src = fs.readFileSync(EXEC_PATH, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

// Anchor lines (1-indexed):
//   48  const BEHAVIORAL_KINDS = new Set([
//   55  export type GateEvaluator (KEEP)
//   57  const RUNG_ESCALATION_ORDER (KEEP)
//   69  export const MAX_IDENTIFIERS = 10;
//   70  const MAX_ESCALATIONS = 2; (KEEP)
//   73  const RUNG_TO_ACTION_TYPE (KEEP)
//   84  const RUNG_TOKEN_FALLBACK_ESTIMATES (KEEP)
//   95  const ALWAYS_STOP_WORDS = new Set([
//  146  const DOMAIN_STOP_WORDS = new Set([
//  189  export const IDENTIFIER_STOP_WORDS = new Set([
//  202  export function buildContextAwareStopWords
//  251  const COMPOUND_STOP_WORDS = new Set([
//  293  export function generateCompoundIdentifiers
//  339  export function extractIdentifiersFromText
//  381  export class Executor (KEEP)

const findFirstStartingWith = (prefix, fromIdx = 0) => {
  for (let i = fromIdx; i < lines.length; i++) {
    if (lines[i].startsWith(prefix)) return i;
  }
  return -1;
};

const idxBehavioral = findFirstStartingWith("const BEHAVIORAL_KINDS");
const idxGateEvaluator = findFirstStartingWith("export type GateEvaluator");
const idxMaxIdent = findFirstStartingWith("export const MAX_IDENTIFIERS");
const idxMaxEscal = findFirstStartingWith("const MAX_ESCALATIONS");
const idxAlwaysStop = findFirstStartingWith("const ALWAYS_STOP_WORDS");
const idxClassExec = findFirstStartingWith("export class Executor");

if (
  idxBehavioral < 0 ||
  idxGateEvaluator < 0 ||
  idxMaxIdent < 0 ||
  idxMaxEscal < 0 ||
  idxAlwaysStop < 0 ||
  idxClassExec < 0
) {
  console.error("Anchor not found", {
    idxBehavioral,
    idxGateEvaluator,
    idxMaxIdent,
    idxMaxEscal,
    idxAlwaysStop,
    idxClassExec,
  });
  process.exit(1);
}

// BEHAVIORAL_KINDS spans from idxBehavioral up to (but not including) idxGateEvaluator.
// Trim trailing blank lines from the block so we don't carry over executor formatting.
const trimTrailingBlanks = (arr) => {
  let end = arr.length;
  while (end > 0 && arr[end - 1].trim() === "") end--;
  return arr.slice(0, end);
};

const behavioralBlock = trimTrailingBlanks(
  lines.slice(idxBehavioral, idxGateEvaluator),
);
const maxIdentLine = lines[idxMaxIdent]; // single line
const identifierBlock = trimTrailingBlanks(
  lines.slice(idxAlwaysStop, idxClassExec),
);

const newFileHeader = [
  "// =============================================================================",
  "// agent/identifier-extraction.ts \u2014 Pure identifier-extraction helpers.",
  "//",
  "// Public exports:",
  "//   - BEHAVIORAL_KINDS, MAX_IDENTIFIERS, IDENTIFIER_STOP_WORDS",
  "//   - buildContextAwareStopWords(queryText)",
  "//   - generateCompoundIdentifiers(text)",
  "//   - extractIdentifiersFromText(text, queryContext?)",
  "//",
  "// Extracted from agent/executor.ts to lower per-file LLM cognitive load.",
  "// All helpers are pure (no I/O, no class deps).",
  "// =============================================================================",
  "",
];

const newFileContent = [
  ...newFileHeader,
  ...behavioralBlock,
  "",
  maxIdentLine,
  "",
  ...identifierBlock,
  "",
].join(eol);

fs.writeFileSync(NEW_PATH, newFileContent, "utf8");
console.log(
  `Wrote ${NEW_PATH} (${newFileContent.split(/\r?\n/).length} lines)`,
);

// ---------------------------------------------------------------------------
// Rewrite executor.ts:
//   keep [0 .. idxBehavioral)
//   drop [idxBehavioral .. idxGateEvaluator)        (BEHAVIORAL_KINDS)
//   keep [idxGateEvaluator .. idxMaxIdent)          (GateEvaluator + RUNG_ESCALATION_ORDER)
//   drop [idxMaxIdent .. idxMaxEscal)               (MAX_IDENTIFIERS line — keep blank ladder)
//   keep [idxMaxEscal .. idxAlwaysStop)             (MAX_ESCALATIONS + RUNG_TO_ACTION_TYPE + RUNG_TOKEN_FALLBACK_ESTIMATES)
//   drop [idxAlwaysStop .. idxClassExec)            (all stop-words + 3 functions)
//   keep [idxClassExec .. end)                      (class Executor onwards)

const importLine =
  `import {${eol}` +
  `  BEHAVIORAL_KINDS,${eol}` +
  `  MAX_IDENTIFIERS,${eol}` +
  `  IDENTIFIER_STOP_WORDS,${eol}` +
  `  buildContextAwareStopWords,${eol}` +
  `  generateCompoundIdentifiers,${eol}` +
  `  extractIdentifiersFromText,${eol}` +
  `} from "./identifier-extraction.js";`;

// Find last `import ` line in first 60 lines and inject after it.
let lastImportIdx = -1;
for (let i = 0; i < Math.min(60, lines.length); i++) {
  if (lines[i].startsWith("import ")) lastImportIdx = i;
}
if (lastImportIdx < 0) {
  console.error("No import lines found in executor.ts header");
  process.exit(1);
}

// Re-export the identifier helpers so external callers (context-engine.ts,
// any future direct importers) keep working without a path change.
const reExportLine =
  `export {${eol}` +
  `  BEHAVIORAL_KINDS,${eol}` +
  `  MAX_IDENTIFIERS,${eol}` +
  `  IDENTIFIER_STOP_WORDS,${eol}` +
  `  buildContextAwareStopWords,${eol}` +
  `  generateCompoundIdentifiers,${eol}` +
  `  extractIdentifiersFromText,${eol}` +
  `};`;

const before = lines.slice(0, lastImportIdx + 1);
const importsTail = lines.slice(lastImportIdx + 1, idxBehavioral);
const keepGateRung = lines.slice(idxGateEvaluator, idxMaxIdent);
const keepMidRung = lines.slice(idxMaxEscal, idxAlwaysStop);
const keepClass = lines.slice(idxClassExec);

const newExecutorLines = [
  ...before,
  importLine,
  ...importsTail,
  ...keepGateRung,
  ...keepMidRung,
  reExportLine,
  "",
  ...keepClass,
];

fs.writeFileSync(EXEC_PATH, newExecutorLines.join(eol), "utf8");
console.log(`Wrote ${EXEC_PATH} (${newExecutorLines.length} lines)`);
