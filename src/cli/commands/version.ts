import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { VersionOptions } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = resolve(__dirname, "../../../package.json");

export async function versionCommand(_options: VersionOptions): Promise<void> {
  const version = getVersion();

  console.log(`SDL-MCP version: ${version}`);
  console.log("");
  console.log("Environment:");
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Arch: ${process.arch}`);
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(VERSION_FILE, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
