import type { ToolContext } from "../../server.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  refreshSemanticEnrichment,
  getSemanticEnrichmentStatus,
  type SemanticEnrichmentStatusResult,
} from "../../semantic/enrichment.js";
import {
  SemanticEnrichmentRefreshRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
} from "../tools.js";

export async function handleSemanticEnrichmentRefresh(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = SemanticEnrichmentRefreshRequestSchema.parse(args);
  return refreshSemanticEnrichment(request, loadConfig());
}

export function compactSemanticEnrichmentStatusForAgent(
  result: SemanticEnrichmentStatusResult,
): object {
  return {
    ...result,
    selections: result.selections.map(({ languageId, selected }) => ({
      languageId,
      ...(selected ? { selected } : {}),
    })),
    lastRuns: result.lastRuns.map(({ metadataJson: _metadataJson, ...run }) => run),
  };
}

export async function handleSemanticEnrichmentStatus(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = SemanticEnrichmentStatusRequestSchema.parse(args);
  const status = await getSemanticEnrichmentStatus(request, loadConfig());
  return compactSemanticEnrichmentStatusForAgent(status);
}
