#!/usr/bin/env node
/**
 * check-tool-inventory.ts
 *
 * Verifies that docs/generated/tool-inventory.json is up to date with
 * the current source files. Re-runs the static extraction logic and compares
 * against the committed inventory. Exits 0 if matching, 1 if drifted.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-tool-inventory.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DESCRIPTORS_PATH = resolve(ROOT, "src", "mcp", "tools", "tool-descriptors.ts");
const CODE_MODE_PATH = resolve(ROOT, "src", "code-mode", "index.ts");
const GATEWAY_PATH = resolve(ROOT, "src", "gateway", "index.ts");
const INVENTORY_PATH = resolve(ROOT, "docs", "generated", "tool-inventory.json");

// ---------------------------------------------------------------------------
// Extraction helpers (duplicated from generate script to stay self-contained)
// ---------------------------------------------------------------------------

function extractFlatToolNames(source: string): string[] {
  const re = /name:\s*"(sdl\.[^"]+)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractRegisteredToolNames(source: string): string[] {
  const re = /registerTool\(\s*"(sdl\.[^"]+)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // Read committed inventory
  let committed: {
    counts: Record<string, number>;
    flatToolNames: string[];
    universalToolNames: string[];
    codeModeToolNames: string[];
    gatewayToolNames: string[];
  };
  try {
    committed = JSON.parse(readFileSync(INVENTORY_PATH, "utf-8"));
  } catch {
    console.error(`ERROR: Could not read ${INVENTORY_PATH}`);
    console.error("Run 'npm run docs:tools:generate' first.");
    process.exit(1);
  }

  // Re-extract from source
  let descriptorsSource: string;
  let codeModeSource: string;
  let gatewaySource: string;

  try {
    descriptorsSource = readFileSync(DESCRIPTORS_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${DESCRIPTORS_PATH}`);
    process.exit(1);
  }
  try {
    codeModeSource = readFileSync(CODE_MODE_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${CODE_MODE_PATH}`);
    process.exit(1);
  }
  try {
    gatewaySource = readFileSync(GATEWAY_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${GATEWAY_PATH}`);
    process.exit(1);
  }

  const flatToolNames = extractFlatToolNames(descriptorsSource).sort();
  const universalToolNames = ["sdl.info", "sdl.action.search"].sort();
  const codeModeToolNames = extractRegisteredToolNames(codeModeSource).sort();
  const gatewayToolNames = extractRegisteredToolNames(gatewaySource).sort();

  const flatToolCount = flatToolNames.length;
  const universalToolCount = universalToolNames.length;
  const codeModeToolCount = codeModeToolNames.length;
  const gatewayToolCount = gatewayToolNames.length;

  const flatModeTotal = universalToolCount + flatToolCount;
  const gatewayModeTotal = universalToolCount + gatewayToolCount;
  const gatewayLegacyModeTotal = universalToolCount + gatewayToolCount + flatToolCount;
  const codeModeExclusiveTotal = codeModeToolCount;
  const allFlatAndCodeModeNames = new Set([...flatToolNames, ...codeModeToolNames]);
  const allFlatAndCodeModeActions = allFlatAndCodeModeNames.size;

  // Compare
  const drifts: string[] = [];

  function checkCount(label: string, fromSource: number, fromInventory: number): void {
    if (fromSource !== fromInventory) {
      drifts.push(`  ${label}: inventory=${fromInventory}, source=${fromSource}`);
    }
  }

  function checkNames(label: string, fromSource: string[], fromInventory: string[]): void {
    const sourceSet = new Set(fromSource);
    const inventorySet = new Set(fromInventory);
    for (const name of fromSource) {
      if (!inventorySet.has(name)) {
        drifts.push(`  ${label}: missing from inventory: ${name}`);
      }
    }
    for (const name of fromInventory) {
      if (!sourceSet.has(name)) {
        drifts.push(`  ${label}: extra in inventory (removed from source?): ${name}`);
      }
    }
  }

  checkCount("flatTools", flatToolCount, committed.counts.flatTools);
  checkCount("universalTools", universalToolCount, committed.counts.universalTools);
  checkCount("codeModeTools", codeModeToolCount, committed.counts.codeModeTools);
  checkCount("gatewayTools", gatewayToolCount, committed.counts.gatewayTools);
  checkCount("flatModeTotal", flatModeTotal, committed.counts.flatModeTotal);
  checkCount("gatewayModeTotal", gatewayModeTotal, committed.counts.gatewayModeTotal);
  checkCount("gatewayLegacyModeTotal", gatewayLegacyModeTotal, committed.counts.gatewayLegacyModeTotal);
  checkCount("codeModeExclusiveTotal", codeModeExclusiveTotal, committed.counts.codeModeExclusiveTotal);
  checkCount("allFlatAndCodeModeActions", allFlatAndCodeModeActions, committed.counts.allFlatAndCodeModeActions);

  checkNames("flatToolNames", flatToolNames, committed.flatToolNames ?? []);
  checkNames("universalToolNames", universalToolNames, committed.universalToolNames ?? []);
  checkNames("codeModeToolNames", codeModeToolNames, committed.codeModeToolNames ?? []);
  checkNames("gatewayToolNames", gatewayToolNames, committed.gatewayToolNames ?? []);

  if (drifts.length === 0) {
    console.log("check-tool-inventory: OK -- inventory matches source files");
    process.exit(0);
  } else {
    console.error("check-tool-inventory: DRIFT DETECTED");
    console.error("");
    for (const drift of drifts) {
      console.error(drift);
    }
    console.error("");
    console.error("Run 'npm run docs:tools:generate' to update.");
    process.exit(1);
  }
}

main();
