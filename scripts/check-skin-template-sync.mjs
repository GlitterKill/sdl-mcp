// Verifies the viewer's compiled-in default skin stays identical to the
// authoring template at templates/skin-pack/skin.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const templatePath = resolve(root, "templates", "skin-pack", "skin.json");
const sourcePath = resolve(root, "src", "ui", "viewer", "skins", "default-skin.ts");

const template = JSON.parse(readFileSync(templatePath, "utf8"));

// Extract the DEFAULT_SKIN object literal from the TS source. The constant is
// plain JSON-compatible data (no expressions), so evaluating the literal after
// stripping the declaration wrapper is safe and keeps this script dependency-free.
const source = readFileSync(sourcePath, "utf8");
const match = source.match(/export const DEFAULT_SKIN[^=]*=\s*(\{[\s\S]*?\n\});/);
if (!match) {
  console.error(`check-skin-template-sync: could not locate DEFAULT_SKIN literal in ${sourcePath}`);
  process.exit(1);
}
let compiled;
try {
  compiled = new Function(`return (${match[1]});`)();
} catch (error) {
  console.error(`check-skin-template-sync: failed to parse DEFAULT_SKIN literal: ${error}`);
  process.exit(1);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

const templateJson = JSON.stringify(canonical(template), null, 2);
const compiledJson = JSON.stringify(canonical(compiled), null, 2);
if (templateJson !== compiledJson) {
  console.error("check-skin-template-sync: DEFAULT_SKIN and templates/skin-pack/skin.json differ.");
  console.error("--- templates/skin-pack/skin.json ---");
  console.error(templateJson);
  console.error("--- src/ui/viewer/skins/default-skin.ts DEFAULT_SKIN ---");
  console.error(compiledJson);
  process.exit(1);
}
console.log("check-skin-template-sync: OK");
