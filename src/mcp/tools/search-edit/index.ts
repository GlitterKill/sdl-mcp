/**
 * `sdl.search.edit` entry point — dispatches between `preview` and
 * `apply` phases backed by the process-wide plan store.
 */

import { attachRawContext } from "../../token-usage.js";
import {
  SearchEditRequestSchema,
  type SearchEditApplyResponse,
  type SearchEditPreviewResponse,
  type SearchEditRequest,
  type SearchEditResponse,
} from "../../tools.js";
import { ValidationError } from "../../../domain/errors.js";
import type { RetrievalEvidence } from "../../../retrieval/types.js";
import type { ToolContext } from "../../../server.js";
import { maybeCompressToolResponse } from "../../response-compression.js";
import { applyBatch } from "./batch-executor.js";
import { getSearchEditPlanStore, type StoredPlan } from "./plan-store.js";
import { planSearchEditPreview, type PreviewResult } from "./planner.js";

const MAX_PREVIEW_SKIPPED_FILES = 25;
const MAX_RETRIEVAL_EVIDENCE_ITEMS = 10;

function computeAggregateRawBytes(plan: StoredPlan): number {
  let bytes = 0;
  for (const edit of plan.edits) {
    bytes += Buffer.byteLength(edit.newContent, "utf-8");
  }
  return bytes;
}

function attachRaw<T extends object>(response: T, rawBytes: number): T {
  return attachRawContext(response, {
    rawTokens: Math.ceil(rawBytes / 4),
  });
}

function summarizeSkippedFiles(
  skipped: Array<{ path: string; reason: string; operationId?: string }>,
): Pick<
  SearchEditPreviewResponse,
  "filesSkipped" | "filesSkippedTotal" | "filesSkippedTruncated" | "filesSkippedByReason"
> {
  const byReason = new Map<string, number>();
  for (const entry of skipped) {
    byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  }
  return {
    filesSkipped: skipped.slice(0, MAX_PREVIEW_SKIPPED_FILES),
    filesSkippedTotal: skipped.length,
    ...(skipped.length > MAX_PREVIEW_SKIPPED_FILES
      ? { filesSkippedTruncated: true }
      : {}),
    filesSkippedByReason: Array.from(byReason, ([reason, count]) => ({
      reason,
      count,
    })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

type SkippedFilesSummary = ReturnType<typeof summarizeSkippedFiles>;

function compactSearchEditFileEntries(
  fileEntries: PreviewResult["summary"]["fileEntries"],
): SearchEditPreviewResponse["fileEntries"] {
  return fileEntries.map(({ astMatches, ...entry }) => ({
    ...entry,
    ...(astMatches
      ? {
          astMatches: astMatches.map((match) => ({
            target: {
              name: match.target.name,
              nodeType: match.target.nodeType,
              text: match.target.text,
            },
            captures: match.captures.map((capture) => ({
              name: capture.name,
              nodeType: capture.nodeType,
              text: capture.text,
            })),
          })),
        }
      : {}),
  }));
}

function compactStoredSummary(
  summary: PreviewResult["summary"],
  skippedSummary: SkippedFilesSummary,
): Record<string, unknown> {
  return {
    ...summary,
    fileEntries: compactSearchEditFileEntries(summary.fileEntries),
    filesSkipped: skippedSummary.filesSkipped,
    filesSkippedTotal: skippedSummary.filesSkippedTotal,
    ...(skippedSummary.filesSkippedTruncated
      ? { filesSkippedTruncated: true }
      : {}),
    filesSkippedByReason: skippedSummary.filesSkippedByReason,
  };
}

function compactRetrievalEvidence(evidence: RetrievalEvidence): RetrievalEvidence {
  const topRanksPerSource = Object.fromEntries(
    Object.entries(evidence.topRanksPerSource).map(([source, ranks]) => [
      source,
      ranks.slice(0, MAX_RETRIEVAL_EVIDENCE_ITEMS),
    ]),
  );

  return {
    ...evidence,
    topRanksPerSource,
    ...(evidence.feedbackBoosts
      ? {
          feedbackBoosts: {
            ...evidence.feedbackBoosts,
            feedbackIds: evidence.feedbackBoosts.feedbackIds.slice(
              0,
              MAX_RETRIEVAL_EVIDENCE_ITEMS,
            ),
          },
        }
      : {}),
    ...(evidence.pprBoosts
      ? {
          pprBoosts: {
            ...evidence.pprBoosts,
            resolvedSeeds: evidence.pprBoosts.resolvedSeeds.slice(
              0,
              MAX_RETRIEVAL_EVIDENCE_ITEMS,
            ),
            unresolvedMentions: evidence.pprBoosts.unresolvedMentions.slice(
              0,
              MAX_RETRIEVAL_EVIDENCE_ITEMS,
            ),
            ambiguousMentions: evidence.pprBoosts.ambiguousMentions.slice(
              0,
              MAX_RETRIEVAL_EVIDENCE_ITEMS,
            ),
          },
        }
      : {}),
  };
}

async function handlePreview(
  request: Extract<SearchEditRequest, { mode: "preview" }>,
  context: ToolContext | undefined,
): Promise<SearchEditResponse> {
  const preview = await planSearchEditPreview({
    repoId: request.repoId,
    targeting: request.targeting,
    query: request.query,
    filters: request.filters,
    editMode: request.editMode,
    operations: request.operations,
    previewContextLines: request.previewContextLines,
    maxFiles: request.maxFiles,
    maxMatchesPerFile: request.maxMatchesPerFile,
    maxTotalMatches: request.maxTotalMatches,
    createBackup: request.createBackup,
  });

  const store = getSearchEditPlanStore();
  const skippedSummary = summarizeSkippedFiles(preview.summary.filesSkipped);
  const storedSummary = compactStoredSummary(preview.summary, skippedSummary);
  const stored = store.create(
    request.repoId,
    preview.edits,
    preview.preconditions,
    storedSummary,
    request.createBackup ?? true,
  );

  const response: SearchEditPreviewResponse = {
    mode: "preview",
    planHandle: stored.planHandle,
    defaultCreateBackup: stored.defaultCreateBackup,
    applyArgs: {
      mode: "apply",
      repoId: request.repoId,
      planHandle: stored.planHandle,
      createBackup: stored.defaultCreateBackup,
    },
    filesMatched: preview.summary.filesMatched,
    matchesFound: preview.summary.matchesFound,
    filesEligible: preview.summary.filesEligible,
    filesSkipped: skippedSummary.filesSkipped,
    filesSkippedTotal: skippedSummary.filesSkippedTotal,
    ...(skippedSummary.filesSkippedTruncated
      ? { filesSkippedTruncated: true }
      : {}),
    filesSkippedByReason: skippedSummary.filesSkippedByReason,
    fileEntries: compactSearchEditFileEntries(preview.summary.fileEntries),
    requiresApply: preview.edits.length > 0,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    ...(preview.summary.partial ? { partial: true } : {}),
    ...(preview.retrievalEvidence
      ? { retrievalEvidence: compactRetrievalEvidence(preview.retrievalEvidence) }
      : {}),
  };
  const rawBytes = computeAggregateRawBytes(stored);
  const enriched = attachRaw(response, rawBytes);
  return maybeCompressToolResponse({
    repoId: request.repoId,
    toolName: "sdl.search.edit",
    payload: enriched,
    responseMode: request.responseMode,
    rawContext: { rawTokens: Math.ceil(rawBytes / 4) },
    sessionId: context?.sessionId,
  });
}

function getApplyFileEntries(
  plan: StoredPlan,
): SearchEditApplyResponse["fileEntries"] | undefined {
  const fileEntries = plan.summary.fileEntries;
  return Array.isArray(fileEntries)
    ? (fileEntries as SearchEditApplyResponse["fileEntries"])
    : undefined;
}

async function handleApply(
  request: Extract<SearchEditRequest, { mode: "apply" }>,
): Promise<SearchEditApplyResponse> {
  const store = getSearchEditPlanStore();
  const plan = store.get(request.planHandle);
  if (!plan) {
    throw new ValidationError(
      `search.edit planHandle missing or expired: ${request.planHandle}`,
    );
  }
  if (plan.repoId !== request.repoId) {
    throw new ValidationError(
      `search.edit planHandle was created for repoId "${plan.repoId}", not "${request.repoId}"`,
    );
  }
  if (
    request.createBackup !== undefined &&
    request.createBackup !== plan.defaultCreateBackup
  ) {
    throw new ValidationError(
      `search.edit apply createBackup=${request.createBackup} does not match preview assumption createBackup=${plan.defaultCreateBackup}. Re-run preview with createBackup=${request.createBackup}, then apply with the same value.`,
    );
  }

  // Atomically claim the plan to prevent concurrent double-apply.
  // The plan is removed on both success and error (see below) so
  // callers must re-preview after any failure.
  if (!store.markConsumed(plan.planHandle)) {
    throw new ValidationError(
      `search.edit planHandle is already being applied: ${plan.planHandle}`,
    );
  }

  let batch;
  try {
    batch = await applyBatch(plan, request.createBackup);
  } catch (err) {
    // Safe default: remove plan on any error, requiring re-preview.
    store.remove(plan.planHandle);
    throw err;
  }

  // Fully applied (or rolled back) — remove the plan.
  store.remove(plan.planHandle);

  const fileEntries = getApplyFileEntries(plan);
  const response: SearchEditApplyResponse = {
    mode: "apply",
    planHandle: request.planHandle,
    filesAttempted: batch.filesAttempted,
    filesWritten: batch.filesWritten,
    filesSkipped: batch.filesSkipped,
    filesFailed: batch.filesFailed,
    results: batch.results,
    ...(fileEntries !== undefined && { fileEntries }),
    rollback: batch.rollback,
  };
  return attachRaw(response, computeAggregateRawBytes(plan));
}

export async function handleSearchEdit(
  args: unknown,
  context?: ToolContext,
): Promise<SearchEditResponse> {
  const request = SearchEditRequestSchema.parse(args);
  if (request.mode === "preview") {
    return handlePreview(request, context);
  }
  return handleApply(request);
}
