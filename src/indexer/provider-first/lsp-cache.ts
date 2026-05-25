import { hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";

export interface LspProviderCacheKeyParts {
  serverId: string;
  serverVersion?: string;
  workspaceRoot: string;
  configHash?: string;
  fileContentHash?: string;
  capabilitySet: readonly string[];
}

export function createLspProviderCacheKey(
  parts: LspProviderCacheKeyParts,
): string {
  const capabilities = [...new Set(parts.capabilitySet)].sort((a, b) =>
    a.localeCompare(b),
  );
  const hash = hashValue({
    schema: "sdl-lsp-provider-cache:v1",
    serverId: parts.serverId,
    serverVersion: parts.serverVersion ?? null,
    workspaceRoot: normalizePath(parts.workspaceRoot),
    configHash: parts.configHash ?? null,
    fileContentHash: parts.fileContentHash ?? null,
    capabilitySet: capabilities,
  });

  return `lsp-cache:${parts.serverId}:${hash}`;
}
