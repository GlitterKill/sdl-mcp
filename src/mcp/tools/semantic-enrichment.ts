import type { ToolContext } from "../../server.js";
import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
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
  const request = parseActionHandlerArgs(
    SemanticEnrichmentRefreshRequestSchema,
    args,
  );
  return refreshSemanticEnrichment(request, loadConfig());
}

type DiagnosticSeveritySummary = Record<
  "error" | "warning" | "information" | "hint",
  number
>;

function diagnosticSeveritySummary(
  metadataJson: string | undefined,
): DiagnosticSeveritySummary | null {
  if (!metadataJson) return null;
  try {
    const parsed: unknown = JSON.parse(metadataJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = (parsed as Record<string, unknown>).diagnosticsBySeverity;
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const values = [
      record.error,
      record.warning,
      record.information,
      record.hint,
    ];
    if (
      !values.every(
        (value) =>
          typeof value === "number" && Number.isInteger(value) && value >= 0,
      )
    ) {
      return null;
    }
    return {
      error: record.error as number,
      warning: record.warning as number,
      information: record.information as number,
      hint: record.hint as number,
    };
  } catch {
    return null;
  }
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
      diagnosticsBySeverity: diagnosticSeveritySummary(run.metadataJson),
      precisionScore: run.precisionScore ?? null,
      precisionMeasurement:
        run.precisionScore === undefined ? "unmeasured" : "measured",
    })),
  };
}

export async function handleSemanticEnrichmentStatus(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = parseActionHandlerArgs(
    SemanticEnrichmentStatusRequestSchema,
    args,
  );
  const status = await getSemanticEnrichmentStatus(request, loadConfig());
  return request.detail === "full"
    ? status
    : compactSemanticEnrichmentStatusForAgent(status, request.limit);
}
