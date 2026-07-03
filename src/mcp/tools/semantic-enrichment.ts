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

const DEFAULT_SEMANTIC_STATUS_LIMIT = 5;

export async function handleSemanticEnrichmentRefresh(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = SemanticEnrichmentRefreshRequestSchema.parse(args);
  return refreshSemanticEnrichment(request, loadConfig());
}

export function compactSemanticEnrichmentStatusForAgent(
  result: SemanticEnrichmentStatusResult,
  limit = DEFAULT_SEMANTIC_STATUS_LIMIT,
): object {
  const selected = result.selections.flatMap(({ languageId, selected }) =>
    selected ? [{ languageId, ...selected }] : [],
  );

  return {
    ...result,
    selections: {
      total: result.selections.length,
      selectedCount: selected.length,
      selected,
    },
    lastRuns: result.lastRuns
      .slice(0, limit)
      .map(({ metadataJson: _metadataJson, ...run }) => run),
  };
}

export async function handleSemanticEnrichmentStatus(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = SemanticEnrichmentStatusRequestSchema.parse(args);
  const status = await getSemanticEnrichmentStatus(request, loadConfig());
  return request.detail === "full"
    ? status
    : compactSemanticEnrichmentStatusForAgent(status, request.limit);
}
