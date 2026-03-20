import { VersionOptions } from "../types.js";
import { getPackageVersion } from "../../util/package-info.js";

export async function versionCommand(_options: VersionOptions): Promise<void> {
  const version = getVersion();

  console.log(`SDL-MCP version: ${version}`);
  console.log("");
  console.log("Environment:");
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Arch: ${process.arch}`);
}

export function getVersion(): string {
  return getPackageVersion();
}
