import type { ToolContext } from "../../server.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  refreshSemanticEnrichment,
  getSemanticEnrichmentStatus,
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

export async function handleSemanticEnrichmentStatus(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = SemanticEnrichmentStatusRequestSchema.parse(args);
  return getSemanticEnrichmentStatus(request, loadConfig());
}
