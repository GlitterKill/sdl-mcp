import type { InfoOptions } from "../types.js";
import { collectInfoReport } from "../../info/report.js";

function printList(title: string, values: string[]): void {
  console.log(`${title}:`);
  if (values.length === 0) {
    console.log("  none");
    return;
  }

  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

export async function infoCommand(options: InfoOptions): Promise<void> {
  const report = await collectInfoReport(options);

  if (options.jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(`SDL-MCP version: ${report.version}`);
  console.log("");
  console.log("Runtime:");
  console.log(`  Node.js: ${report.runtime.node}`);
  console.log(`  Platform: ${report.runtime.platform}`);
  console.log(`  Arch: ${report.runtime.arch}`);
  console.log("");
  console.log("Config:");
  console.log(`  Path: ${report.config.path}`);
  console.log(`  Exists: ${report.config.exists ? "yes" : "no"}`);
  console.log(`  Loaded: ${report.config.loaded ? "yes" : "no"}`);
  console.log("");
  console.log("Logging:");
  console.log(`  File: ${report.logging.path ?? "disabled"}`);
  console.log(
    `  Console mirroring: ${report.logging.consoleMirroring ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Fallback path: ${report.logging.fallbackUsed ? "yes" : "no"}`,
  );
  console.log("");
  console.log("Ladybug:");
  console.log(`  Available: ${report.ladybug.available ? "yes" : "no"}`);
  console.log(`  Active path: ${report.ladybug.activePath ?? "not initialized"}`);
  console.log("");
  console.log("Native addon:");
  console.log(`  Available: ${report.native.available ? "yes" : "no"}`);
  console.log(`  Source path: ${report.native.sourcePath ?? "not loaded"}`);
  console.log(`  Reason: ${report.native.reason}`);
  console.log("");

  printList("Warnings", report.warnings);
  console.log("");
  printList("Misconfigurations", report.misconfigurations);
}
