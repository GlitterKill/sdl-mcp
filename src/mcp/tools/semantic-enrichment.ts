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
  const languagesWithSelection = result.selections
    .filter((selection) => selection.selected !== undefined)
    .map((selection) => selection.languageId);
  const skippedCount = result.selections.reduce(
    (count, selection) => count + selection.skipped.length,
    0,
  );

  return {
    ok: result.ok,
    repoId: result.repoId,
    enabled: result.enabled,
    autoRunOnIndexRefresh: result.autoRunOnIndexRefresh,
    installPolicy: result.installPolicy,
    selections: {
      totalLanguages: result.selections.length,
      selectedLanguages: languagesWithSelection.length,
      skippedProviders: skippedCount,
      languagesWithSelection,
    },
    lastRuns: result.lastRuns.slice(0, limit).map((run) => ({
      runId: run.runId,
      providerType: run.providerType,
      providerId: run.providerId,
      languages: run.languages,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      symbolsMatched: run.symbolsMatched,
      edgesCreated: run.edgesCreated,
      diagnosticsCount: run.diagnosticsCount,
      precisionScore: run.precisionScore,
    })),
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
