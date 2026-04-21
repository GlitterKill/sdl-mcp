/**
 * Sequential cross-file write executor for `sdl.search.edit apply`.
 *
 * Preconditions are re-verified against current disk state before the
 * first write. Writes happen in deterministic order (localeCompare of
 * normalized relative path). On mid-batch failure all already-written
 * files are rolled back from their backups. Live-index sync failures
 * are surfaced as warnings but never cause rollback.
 */

import { stat, unlink } from "fs/promises";
import { realpathSync } from "fs";
import { randomBytes } from "crypto";

import { logger } from "../../../util/logger.js";
import { ValidationError } from "../../../domain/errors.js";
import { validatePathWithinRoot } from "../../../util/paths.js";
import { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import {
  hashFileIfExists,
  removeBackup,
  restoreBackup,
  syncLiveIndex,
  writeWithBackup,
} from "../file-write-internals.js";
import type { FileWriteResponse } from "../../tools.js";
import type { PlannedFileEdit, StoredPlan } from "./plan-store.js";

export interface BatchApplyResult {
  filesAttempted: number;
  filesWritten: number;
  filesSkipped: number;
  filesFailed: number;
  results: Array<{
    file: string;
    status: "written" | "skipped" | "failed" | "rolled-back";
    bytes?: number;
    reason?: string;
    indexUpdate?: FileWriteResponse["indexUpdate"];
  }>;
  rollback: {
    triggered: boolean;
    restoredFiles: string[];
  };
}

export interface BatchPreflightFailure {
  file: string;
  reason: string;
}

/**
 * Recheck preconditions for every file. Returns a list of drifted
 * files (empty = all clear).
 */
export async function preflightPreconditions(
  plan: StoredPlan,
): Promise<BatchPreflightFailure[]> {
  const failures: BatchPreflightFailure[] = [];
  // Look up repo rootPath for TOCTOU symlink validation
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, plan.repoId);
  if (!repo) {
    return [{ file: "*", reason: "repo-not-found" }];
  }
  const rootPath = repo.rootPath;
  for (const pc of plan.preconditions) {
    let currentSha: string | null = null;
    let currentMtime: number | null = null;
    try {
      currentSha = await hashFileIfExists(pc.absPath);
      try {
        const s = await stat(pc.absPath);
        currentMtime = s.mtimeMs;
      } catch {
        currentMtime = null;
      }
    } catch (err) {
      failures.push({
        file: pc.relPath,
        reason: `hash-error:${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }
    // TOCTOU: re-verify path hasn't been swapped for a symlink escape
    try {
      const resolved = realpathSync(pc.absPath);
      if (resolved !== pc.absPath) {
        validatePathWithinRoot(rootPath, resolved);
      }
    } catch (err) {
      failures.push({
        file: pc.relPath,
        reason: `symlink-escape:${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }
    if (currentSha !== pc.sha256) {
      failures.push({
        file: pc.relPath,
        reason: "sha256-drift",
      });
      continue;
    }
    if (
      pc.mtimeMs !== null &&
      currentMtime !== null &&
      currentMtime > pc.mtimeMs + 1
    ) {
      // mtime-only drift is informational — sha256 is the authoritative check.
      logger.debug(
        `search.edit: mtime advanced for ${pc.relPath} but sha matches`,
      );
    }
  }
  return failures;
}

function sortedEdits(edits: PlannedFileEdit[]): PlannedFileEdit[] {
  return [...edits].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export async function applyBatch(
  plan: StoredPlan,
  overrideCreateBackup: boolean | undefined,
): Promise<BatchApplyResult> {
  // 1. prevalidate
  const preflight = await preflightPreconditions(plan);
  if (preflight.length > 0) {
    throw new ValidationError(
      `search.edit apply aborted: ${preflight.length} file(s) drifted: ${preflight
        .map((f) => `${f.file} (${f.reason})`)
        .join(", ")}`,
    );
  }

  // Look up repo rootPath for TOCTOU symlink re-check at write time
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, plan.repoId);
  if (!repo) throw new ValidationError(`Repository ${plan.repoId} not found`);
  const rootPath = repo.rootPath;

  const results: BatchApplyResult["results"] = [];
  const writtenSoFar: Array<{
    edit: PlannedFileEdit;
    backupPath: string | undefined;
  }> = [];
  const restoredFiles: string[] = [];
  let rollbackTriggered = false;

  const edits = sortedEdits(plan.edits);
  const preconditionByPath = new Map(
    plan.preconditions.map((pc) => [pc.relPath, pc] as const),
  );
  // 2. sequential writes
  for (let editIdx = 0; editIdx < edits.length; editIdx++) {
    const edit = edits[editIdx];
    const backupSuffix = `.se-${randomBytes(6).toString("hex")}.bak`;
    const useBackup = edits.length > 1
      ? true
      : overrideCreateBackup !== undefined
        ? overrideCreateBackup
        : edit.createBackup;
    try {
      const pc = preconditionByPath.get(edit.relPath);
      if (pc) {
        const currentSha = await hashFileIfExists(pc.absPath);
        if (currentSha !== pc.sha256) {
          throw new Error(
            `drift-during-apply: ${edit.relPath} sha256 changed between preflight and write`,
          );
        }
      }
      // TOCTOU: re-verify path hasn't been swapped for a symlink escape
      try {
        const resolved = realpathSync(edit.absPath);
        if (resolved !== edit.absPath) {
          validatePathWithinRoot(rootPath, resolved);
        }
      } catch (symErr) {
        throw new Error(
          `symlink-escape-at-write: ${edit.relPath}: ${symErr instanceof Error ? symErr.message : String(symErr)}`,
        );
      }
      const backupPath = await writeWithBackup(
        edit.absPath,
        edit.newContent,
        useBackup,
        edit.fileExists,
        backupSuffix,
      );
      writtenSoFar.push({ edit, backupPath });
      results.push({
        file: edit.relPath,
        status: "written",
        bytes: Buffer.byteLength(edit.newContent, "utf-8"),
      });
    } catch (err) {
      rollbackTriggered = true;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `search.edit apply failed on ${edit.relPath}: ${message} — rolling back`,
      );
      // Rollback all previously-written files.
      for (const prev of [...writtenSoFar].reverse()) {
        if (!prev.backupPath) {
          if (prev.edit.fileExists) {
            // Existing file overwritten without backup — cannot restore.
            logger.error(
              `search.edit cannot rollback ${prev.edit.relPath}: no backup exists (createBackup was false)`,
            );
            continue;
          }
          try {
            await unlink(prev.edit.absPath);
            restoredFiles.push(prev.edit.relPath);
          } catch (unlinkErr) {
            logger.error(
              `search.edit failed to remove newly-created ${prev.edit.relPath}: ${
                unlinkErr instanceof Error
                  ? unlinkErr.message
                  : String(unlinkErr)
              }`,
            );
          }
          continue;
        }
        try {
          await restoreBackup(prev.edit.absPath, prev.backupPath);
          restoredFiles.push(prev.edit.relPath);
        } catch (restoreErr) {
          logger.error(
            `search.edit failed to restore ${prev.edit.relPath}: ${
              restoreErr instanceof Error
                ? restoreErr.message
                : String(restoreErr)
            }`,
          );
        }
      }
      results.push({
        file: edit.relPath,
        status: "failed",
        reason: message,
      });
      // Remaining edits are skipped.
      for (const remaining of edits.slice(editIdx + 1)) {
        results.push({
          file: remaining.relPath,
          status: "skipped",
          reason: "batch-aborted-earlier-failure",
        });
      }
      break;
    }
  }

  // 3. live-index sync (best-effort, no rollback on failure)
  if (!rollbackTriggered) {
    for (const entry of writtenSoFar) {
      if (!entry.edit.indexedSource) continue;
      const indexUpdate = await syncLiveIndex(
        plan.repoId,
        entry.edit.relPath,
        entry.edit.newContent,
      );
      const matching = results.find((r) => r.file === entry.edit.relPath);
      if (matching && indexUpdate) {
        matching.indexUpdate = indexUpdate;
      }
    }

    // 4. cleanup backups on full success
    for (const entry of writtenSoFar) {
      if (entry.backupPath) {
        try {
          await removeBackup(entry.backupPath);
        } catch (err) {
          logger.warn(
            `search.edit backup cleanup failed for ${entry.edit.relPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  const restoredSet = new Set(restoredFiles);
  if (rollbackTriggered) {
    for (const r of results) {
      if (r.status === "written" && restoredSet.has(r.file)) {
        r.status = "rolled-back";
      }
    }
  }

  const filesWritten = results.filter((r) => r.status === "written").length;
  const filesSkipped = results.filter((r) => r.status === "skipped").length;
  const filesFailed = results.filter((r) => r.status === "failed").length;

  return {
    filesAttempted: edits.length,
    filesWritten,
    filesSkipped,
    filesFailed,
    results,
    rollback: {
      triggered: rollbackTriggered,
      restoredFiles,
    },
  };
}
