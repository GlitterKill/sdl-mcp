import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPackageVersion } from "./package-info.js";
import { normalizePath } from "./paths.js";

export interface RuntimeIdentity {
  version: string;
  node: string;
  modulePath: string;
}

export interface ServerInfo {
  version: string;
  node: string;
  startedAt: string;
  modulePath?: string;
  driftWarnings: string[];
}

const SERVER_STARTED_AT = new Date().toISOString();

const DRIFT_PAIRS: Array<[source: string, dist: string]> = [
  ["src/mcp/tools/runtime.ts", "dist/mcp/tools/runtime.js"],
  ["src/mcp/tools/runtime-query.ts", "dist/mcp/tools/runtime-query.js"],
  ["src/runtime/artifacts.ts", "dist/runtime/artifacts.js"],
  ["src/mcp/tools.ts", "dist/mcp/tools.js"],
  ["src/gateway/schemas.ts", "dist/gateway/schemas.js"],
  ["src/code-mode/manual-generator.ts", "dist/code-mode/manual-generator.js"],
];

function detectDriftWarnings(root = process.cwd()): string[] {
  const warnings: string[] = [];
  for (const [sourceRel, distRel] of DRIFT_PAIRS) {
    const sourcePath = join(root, sourceRel);
    const distPath = join(root, distRel);
    try {
      if (!existsSync(sourcePath) || !existsSync(distPath)) continue;
      const sourceMtime = statSync(sourcePath).mtimeMs;
      const distMtime = statSync(distPath).mtimeMs;
      if (sourceMtime > distMtime + 1000) {
        warnings.push(
          `${normalizePath(sourceRel)} is newer than ${normalizePath(distRel)}; rebuild or restart the server`,
        );
      }
    } catch {
      // Drift checks are diagnostic only and must not break tool responses.
    }
  }
  return warnings;
}

export function createRuntimeIdentity(moduleUrl: string): RuntimeIdentity {
  return {
    version: getPackageVersion(),
    node: process.version,
    modulePath: fileURLToPath(moduleUrl),
  };
}

export function getServerInfo(moduleUrl?: string): ServerInfo {
  const modulePath = moduleUrl ? fileURLToPath(moduleUrl) : undefined;
  return {
    version: getPackageVersion(),
    node: process.version,
    startedAt: SERVER_STARTED_AT,
    ...(modulePath ? { modulePath } : {}),
    driftWarnings: detectDriftWarnings(),
  };
}

export function formatRuntimeIdentityLine(
  identity: RuntimeIdentity,
  label = "Runtime",
): string {
  return (
    `${label}: sdl-mcp ${identity.version}; ` +
    `node=${identity.node}; module=${normalizePath(identity.modulePath)}`
  );
}
