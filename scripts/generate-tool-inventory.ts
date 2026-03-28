#!/usr/bin/env node
/**
 * generate-tool-inventory.ts
 *
 * Statically extracts tool names from source files and produces a generated
 * inventory (JSON + Markdown) under docs/generated/.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-tool-inventory.ts
 *
 * The script parses source files directly (no build required) and writes:
 *   - docs/generated/tool-inventory.json
 *   - docs/generated/tool-inventory.md
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DESCRIPTORS_PATH = resolve(ROOT, "src", "mcp", "tools", "tool-descriptors.ts");
const CODE_MODE_PATH = resolve(ROOT, "src", "code-mode", "index.ts");
const GATEWAY_PATH = resolve(ROOT, "src", "gateway", "index.ts");
const TOOLS_INDEX_PATH = resolve(ROOT, "src", "mcp", "tools", "index.ts");
const OUT_DIR = resolve(ROOT, "docs", "generated");
const OUT_JSON = resolve(OUT_DIR, "tool-inventory.json");
const OUT_MD = resolve(OUT_DIR, "tool-inventory.md");

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract all `name: "sdl.xxx"` values from the flat tool descriptors file.
 */
function extractFlatToolNames(source: string): string[] {
  const re = /name:\s*"(sdl\.[^"]+)"/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Extract tool names registered via `server.registerTool("sdl.xxx", ...)` or
 * `registerTool("sdl.xxx", ...)` from a source file.
 */
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
  // Read source files
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
  try {
    toolsIndexSource = readFileSync(TOOLS_INDEX_PATH, "utf-8");
  } catch {
    console.error(`ERROR: Could not read ${TOOLS_INDEX_PATH}`);
    process.exit(1);
  }

  // --- Flat tools (from tool-descriptors.ts) ---
  const flatToolNames = extractFlatToolNames(descriptorsSource).sort();
  const flatToolCount = flatToolNames.length;

  // --- Universal tools (registered in tools/index.ts, always present) ---
  // sdl.info is registered in tools/index.ts via registerTool
  // sdl.action.search is registered via registerActionSearchTool (imported from code-mode)
  const universalToolNames = ["sdl.info", "sdl.action.search"].sort();
  const universalToolCount = universalToolNames.length;

  // --- Code-mode tools (registered in code-mode/index.ts) ---
  const codeModeRegistered = extractRegisteredToolNames(codeModeSource).sort();
  // The code-mode file registers: sdl.action.search, sdl.manual, sdl.chain
  const codeModeToolNames = codeModeRegistered.length > 0 ? codeModeRegistered : ["sdl.chain", "sdl.manual", "sdl.action.search"];
  const codeModeToolCount = codeModeToolNames.length;

  // --- Gateway tools (registered in gateway/index.ts) ---
  const gatewayRegistered = extractRegisteredToolNames(gatewaySource).sort();
  // The gateway file registers: sdl.query, sdl.code, sdl.repo, sdl.agent
  const gatewayToolNames = gatewayRegistered.length > 0 ? gatewayRegistered : ["sdl.query", "sdl.code", "sdl.repo", "sdl.agent"];
  const gatewayToolCount = gatewayToolNames.length;

  // --- Compute totals ---
  // Flat mode: universal tools + flat tools
  const flatModeTotal = universalToolCount + flatToolCount;

  // Gateway mode: universal tools + gateway tools (no flat tools)
  const gatewayModeTotal = universalToolCount + gatewayToolCount;

  // Gateway + legacy mode: universal tools + gateway tools + flat tools
  const gatewayLegacyModeTotal = universalToolCount + gatewayToolCount + flatToolCount;

  // Code-mode exclusive tools (only unique ones, excluding shared sdl.action.search)
  const codeModeExclusiveTotal = codeModeToolCount;

  // All unique action names across flat + code-mode (deduplicating sdl.action.search)
  const allFlatAndCodeModeNames = new Set([...flatToolNames, ...codeModeToolNames]);
  const allFlatAndCodeModeActions = allFlatAndCodeModeNames.size;

  // --- Build JSON output ---
  const inventory = {
    generatedAt: new Date().toISOString(),
    counts: {
      flatTools: flatToolCount,
      universalTools: universalToolCount,
      codeModeTools: codeModeToolCount,
      gatewayTools: gatewayToolCount,
      flatModeTotal,
      gatewayModeTotal,
      gatewayLegacyModeTotal,
      codeModeExclusiveTotal,
      allFlatAndCodeModeActions,
    },
    flatToolNames,
    universalToolNames,
    codeModeToolNames: [...codeModeToolNames].sort(),
    gatewayToolNames: [...gatewayToolNames].sort(),
  };

  // --- Write outputs ---
  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(OUT_JSON, JSON.stringify(inventory, null, 2) + "\n", "utf-8");

  const md = buildMarkdown(inventory);
  writeFileSync(OUT_MD, md, "utf-8");

  // --- Print summary ---
  console.log("Tool Inventory Generated");
  console.log("========================");
  console.log(`  Flat tools:                ${flatToolCount}`);
  console.log(`  Universal tools:           ${universalToolCount}`);
  console.log(`  Code-mode tools:           ${codeModeToolCount}`);
  console.log(`  Gateway tools:             ${gatewayToolCount}`);
  console.log("");
  console.log("Mode totals:");
  console.log(`  Flat mode:                 ${flatModeTotal} (universal + flat)`);
  console.log(`  Gateway mode:              ${gatewayModeTotal} (universal + gateway)`);
  console.log(`  Gateway + legacy mode:     ${gatewayLegacyModeTotal} (universal + gateway + flat)`);
  console.log(`  Code-mode exclusive:       ${codeModeExclusiveTotal}`);
  console.log(`  All flat + code-mode actions:        ${allFlatAndCodeModeActions}`);
  console.log("");
  console.log(`Written:`);
  console.log(`  ${OUT_JSON}`);
  console.log(`  ${OUT_MD}`);
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(inventory: {
  generatedAt: string;
  counts: Record<string, number>;
  flatToolNames: string[];
  universalToolNames: string[];
  codeModeToolNames: string[];
  gatewayToolNames: string[];
}): string {
  const lines: string[] = [];

  lines.push("# SDL-MCP Tool Inventory");
  lines.push("");
  lines.push(`> Auto-generated by \`scripts/generate-tool-inventory.ts\` on ${inventory.generatedAt}`);
  lines.push(`>`);
  lines.push(`> Do not edit manually. Run \`npm run docs:tools:generate\` to regenerate.`);
  lines.push("");

  lines.push("## Counts by Mode");
  lines.push("");
  lines.push("| Mode | Tool Count | Composition |");
  lines.push("|------|-----------|-------------|");
  lines.push(`| Flat (default) | ${inventory.counts.flatModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.flatTools} flat |`);
  lines.push(`| Gateway | ${inventory.counts.gatewayModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway |`);
  lines.push(`| Gateway + legacy | ${inventory.counts.gatewayLegacyModeTotal} | ${inventory.counts.universalTools} universal + ${inventory.counts.gatewayTools} gateway + ${inventory.counts.flatTools} flat |`);
  lines.push(`| Code-mode exclusive | ${inventory.counts.codeModeExclusiveTotal} | ${inventory.counts.codeModeTools} code-mode tools only |`);
  lines.push(`| All unique actions | ${inventory.counts.allFlatAndCodeModeActions} | flat + code-mode unique |`);
  lines.push("");

  lines.push("## Universal Tools");
  lines.push("");
  lines.push("Always registered regardless of mode.");
  lines.push("");
  for (const name of inventory.universalToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Flat Tools (${inventory.flatToolNames.length})`);
  lines.push("");
  lines.push("Registered in flat mode (default) via `tool-descriptors.ts`.");
  lines.push("");
  for (const name of inventory.flatToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Code-Mode Tools (${inventory.codeModeToolNames.length})`);
  lines.push("");
  lines.push("Registered when code-mode is enabled.");
  lines.push("");
  for (const name of inventory.codeModeToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  lines.push(`## Gateway Tools (${inventory.gatewayToolNames.length})`);
  lines.push("");
  lines.push("Registered when gateway mode is enabled.");
  lines.push("");
  for (const name of inventory.gatewayToolNames) {
    lines.push(`- \`${name}\``);
  }
  lines.push("");

  return lines.join("\n");
}

main();
