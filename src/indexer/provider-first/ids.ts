import type { Range } from "../../domain/types.js";
import { hashValue } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import type { ProviderSourceType } from "./types.js";

export interface ProviderSymbolIdParts {
  repoId: string;
  providerType: Exclude<ProviderSourceType, "legacy">;
  providerId: string;
  providerVersion?: string;
  providerSymbolId: string;
  sourcePath?: string;
  range?: Range;
}

export interface ProviderOccurrenceIdParts extends ProviderSymbolIdParts {
  occurrenceRange: Range;
  occurrenceRole: string;
}

export interface ProviderEdgeDedupeKeyParts {
  sourceSymbolId: string;
  targetSymbolId: string;
  edgeType: string;
  providerId: string;
}

function normalizedRange(range: Range | undefined): Range | null {
  if (!range) return null;
  return {
    startLine: range.startLine,
    startCol: range.startCol,
    endLine: range.endLine,
    endCol: range.endCol,
  };
}

/**
 * Stable SDL symbol identity for provider-first facts.
 *
 * Provider version is intentionally excluded. Native provider IDs are stored
 * separately, while this SDL ID survives ordinary SCIP/LSP version drift.
 */
export function createProviderSymbolId(parts: ProviderSymbolIdParts): string {
  return hashValue({
    schema: "sdl-provider-symbol-id:v2",
    repoId: parts.repoId,
    providerType: parts.providerType,
    providerId: parts.providerId,
    providerSymbolId: parts.providerSymbolId,
    sourcePath: parts.sourcePath ? normalizePath(parts.sourcePath) : null,
  });
}

export function createProviderOccurrenceId(
  parts: ProviderOccurrenceIdParts,
): string {
  return hashValue({
    schema: "sdl-provider-occurrence-id:v1",
    symbolId: createProviderSymbolId(parts),
    providerSymbolId: parts.providerSymbolId,
    occurrenceRange: normalizedRange(parts.occurrenceRange),
    occurrenceRole: parts.occurrenceRole,
  });
}

export function createProviderEdgeDedupeKey(
  parts: ProviderEdgeDedupeKeyParts,
): string {
  return [
    parts.sourceSymbolId,
    parts.targetSymbolId,
    parts.edgeType,
    parts.providerId,
  ].join("|");
}
