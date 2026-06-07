import { fileURLToPath } from "node:url";

import { getPackageVersion } from "./package-info.js";
import { normalizePath } from "./paths.js";

export interface RuntimeIdentity {
  version: string;
  node: string;
  modulePath: string;
}

export function createRuntimeIdentity(moduleUrl: string): RuntimeIdentity {
  return {
    version: getPackageVersion(),
    node: process.version,
    modulePath: fileURLToPath(moduleUrl),
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
