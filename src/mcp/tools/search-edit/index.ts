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
import { applyBatch } from "./batch-executor.js";
import { getSearchEditPlanStore, type StoredPlan } from "./plan-store.js";
import { planSearchEditPreview } from "./planner.js";

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

async function handlePreview(
  request: Extract<SearchEditRequest, { mode: "preview" }>,
): Promise<SearchEditPreviewResponse> {
  const preview = await planSearchEditPreview({
    repoId: request.repoId,
    targeting: request.targeting,
    query: request.query,
    filters: request.filters,
    editMode: request.editMode,
    previewContextLines: request.previewContextLines,
    maxFiles: request.maxFiles,
    maxMatchesPerFile: request.maxMatchesPerFile,
    maxTotalMatches: request.maxTotalMatches,
    createBackup: request.createBackup,
  });

  const store = getSearchEditPlanStore();
  const stored = store.create(
    request.repoId,
    preview.edits,
    preview.preconditions,
    preview.summary,
    request.createBackup ?? true,
  );

  const response: SearchEditPreviewResponse = {
    mode: "preview",
    planHandle: stored.planHandle,
    filesMatched: preview.summary.filesMatched,
    matchesFound: preview.summary.matchesFound,
    filesEligible: preview.summary.filesEligible,
    filesSkipped: preview.summary.filesSkipped,
    fileEntries: preview.summary.fileEntries,
    requiresApply: preview.edits.length > 0,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    preconditionSnapshot: preview.preconditions.map((pc) => ({
      file: pc.relPath,
      sha256: pc.sha256,
      mtimeMs: pc.mtimeMs,
    })),
    ...(preview.summary.partial ? { partial: true } : {}),
    ...(preview.retrievalEvidence
      ? { retrievalEvidence: preview.retrievalEvidence }
      : {}),
  };
  return attachRaw(response, computeAggregateRawBytes(stored));
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
      `search.edit apply createBackup=${request.createBackup} does not match preview assumption createBackup=${plan.defaultCreateBackup}. Re-run preview with the desired value.`,
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

  const response: SearchEditApplyResponse = {
    mode: "apply",
    planHandle: request.planHandle,
    filesAttempted: batch.filesAttempted,
    filesWritten: batch.filesWritten,
    filesSkipped: batch.filesSkipped,
    filesFailed: batch.filesFailed,
    results: batch.results,
    rollback: batch.rollback,
  };
  return attachRaw(response, computeAggregateRawBytes(plan));
}

export async function handleSearchEdit(
  args: unknown,
): Promise<SearchEditResponse> {
  const request = SearchEditRequestSchema.parse(args);
  if (request.mode === "preview") {
    return handlePreview(request);
  }
  return handleApply(request);
}
