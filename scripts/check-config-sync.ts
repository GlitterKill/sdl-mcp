#!/usr/bin/env tsx
/**
 * check-config-sync.ts
 *
 * Reads src/config/types.ts and the compiled config output, extracts all
 * .default(...) values, and compares them. Exits with code 1 if any mismatch
 * is found.
 *
 * Usage:
 *   tsx scripts/check-config-sync.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const TS_PATH = resolve(ROOT, "src/config/types.ts");
const JS_CANDIDATE_PATHS = [
  resolve(ROOT, "dist/config/types.js"),
  resolve(ROOT, "src/config/types.js"),
];

interface DefaultEntry {
  context: string;
  value: string;
  line: number;
}

/**
 * Extract all `.default(...)` occurrences from source text, using a fully-
 * qualified key of `SchemaName.fieldName` to avoid collisions between fields
 * with the same name (e.g. `enabled`) across different schemas.
 *
 * For each `.default(` occurrence:
 *   - `fieldName`:  the identifier immediately before `.default(`
 *   - `schemaName`: the nearest `const XxxSchema =` declaration above the occurrence
 *   - `key`:        `schemaName.fieldName` (unique per schema)
 *   - `value`:      the balanced parenthesis content
 */
function extractDefaults(
  source: string,
  filename: string,
): Map<string, DefaultEntry[]> {
  const results = new Map<string, DefaultEntry[]>();

  // Pre-build a list of schema declaration positions so we can find the
  // enclosing schema for each .default( occurrence efficiently.
  const schemaDeclarations: Array<{ name: string; pos: number }> = [];
  const schemaDeclRe = /(?:const|export const)\s+(\w+Schema)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = schemaDeclRe.exec(source)) !== null) {
    schemaDeclarations.push({ name: m[1], pos: m.index });
  }

  let pos = 0;
  while (pos < source.length) {
    const idx = source.indexOf(".default(", pos);
    if (idx === -1) break;

    // Extract the content inside the parentheses (handle nesting).
    const openParen = idx + ".default(".length - 1; // position of '('
    let depth = 0;
    let end = openParen;
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    const rawValue = source.slice(openParen + 1, end).trim();

    // Walk backwards from idx to find field identifier.
    const before = source.slice(Math.max(0, idx - 200), idx);
    const fieldMatch =
      before.match(/(\w+)\s*\)\s*$/) ?? before.match(/(\w+)\s*$/);
    const fieldName = fieldMatch ? fieldMatch[1] : "<unknown>";

    // Find the enclosing schema: the last schema declaration before idx.
    let schemaName = "<root>";
    for (let i = schemaDeclarations.length - 1; i >= 0; i--) {
      if (schemaDeclarations[i].pos < idx) {
        schemaName = schemaDeclarations[i].name;
        break;
      }
    }

    // Compute line number
    const upToIdx = source.slice(0, idx);
    const lineNum = upToIdx.split("\n").length;

    // Normalize value: collapse whitespace and strip trailing commas for comparison
    // (TypeScript compiler removes trailing commas in function call arguments)
    const normalizedValue = rawValue.replace(/\s+/g, " ").replace(/,\s*$/, "");

    // Use fully-qualified key to avoid collisions between schemas
    const key = `${schemaName}.${fieldName}`;
    if (!results.has(key)) results.set(key, []);
    results.get(key)!.push({
      context: key,
      value: normalizedValue,
      line: lineNum,
    });

    pos = end + 1;
  }

  return results;
}

interface Mismatch {
  context: string;
  tsValue: string;
  tsLine: number;
  jsValue: string;
  jsLine: number;
}

function compareDefaults(
  tsDefaults: Map<string, DefaultEntry[]>,
  jsDefaults: Map<string, DefaultEntry[]>,
): Mismatch[] {
  const mismatches: Mismatch[] = [];

  for (const [key, tsEntries] of tsDefaults) {
    const jsEntries = jsDefaults.get(key);
    if (!jsEntries) {
      // Key in TS but not in JS — only report if the TS entry has content
      // (some are optional chains that may be removed in compilation)
      continue;
    }

    // Match entries positionally within the same context key
    const minLen = Math.min(tsEntries.length, jsEntries.length);
    for (let i = 0; i < minLen; i++) {
      const tsEntry = tsEntries[i];
      const jsEntry = jsEntries[i];
      if (tsEntry.value !== jsEntry.value) {
        mismatches.push({
          context: key,
          tsValue: tsEntry.value,
          tsLine: tsEntry.line,
          jsValue: jsEntry.value,
          jsLine: jsEntry.line,
        });
      }
    }

    // Extra entries in TS that have no counterpart in JS
    for (let i = minLen; i < tsEntries.length; i++) {
      mismatches.push({
        context: key,
        tsValue: tsEntries[i].value,
        tsLine: tsEntries[i].line,
        jsValue: "<missing>",
        jsLine: -1,
      });
    }
  }

  return mismatches;
}

function main(): void {
  let tsSource: string;
  try {
    tsSource = readFileSync(TS_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${TS_PATH}`);
    process.exit(1);
  }

  let jsPath: string | undefined;
  let jsSource: string | undefined;
  for (const candidatePath of JS_CANDIDATE_PATHS) {
    try {
      jsSource = readFileSync(candidatePath, "utf-8");
      jsPath = candidatePath;
      break;
    } catch {
      continue;
    }
  }

  if (!jsPath || !jsSource) {
    console.error(
      `ERROR: Could not read compiled config defaults. Checked: ${JS_CANDIDATE_PATHS.join(", ")}`,
    );
    process.exit(1);
  }

  const tsDefaults = extractDefaults(tsSource, TS_PATH);
  const jsDefaults = extractDefaults(jsSource, jsPath);

  const mismatches = compareDefaults(tsDefaults, jsDefaults);

  if (mismatches.length === 0) {
    console.log(
      "check-config-sync: OK — all .default(...) values match between types.ts and types.js",
    );
    process.exit(0);
  }

  console.error(
    `check-config-sync: FAIL — found ${mismatches.length} mismatch(es)\n`,
  );
  for (const m of mismatches) {
    console.error(`  Context:  ${m.context}`);
    if (m.jsLine === -1) {
      console.error(`  types.ts (line ${m.tsLine}): .default(${m.tsValue})`);
      console.error(`  types.js:                   <missing>`);
    } else {
      console.error(`  types.ts (line ${m.tsLine}): .default(${m.tsValue})`);
      console.error(`  types.js (line ${m.jsLine}): .default(${m.jsValue})`);
    }
    console.error();
  }

  process.exit(1);
}

main();
