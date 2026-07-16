import { access, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { normalizePath } from "../../util/paths.js";
import type { ProviderFirstShadowBuildSummary } from "./shadow-build.js";

export type ProviderFirstShadowActivationStatus =
  | "activated"
  | "skipped"
  | "failed";
export type ProviderFirstShadowActivationRollbackStatus =
  | "notNeeded"
  | "restored"
  | "failed";

export interface ProviderFirstShadowActivationSummary {
  status: ProviderFirstShadowActivationStatus;
  activeDbPath?: string;
  shadowDbPath?: string;
  previousDbPath?: string;
  activatedAt?: string;
  durationMs?: number;
  rollback?: ProviderFirstShadowActivationRollbackStatus;
  reasons: string[];
}

export interface ProviderFirstShadowActivationReadinessParams {
  shadowBuild?: ProviderFirstShadowBuildSummary;
  fallbackFiles: number;
  graphDerivedStateReady: boolean;
  shadowContainsFinalizedGraph: boolean;
  finalizedGraphReasons?: string[];
}

export interface ProviderFirstShadowActivationFs {
  access?: typeof access;
  rename?: typeof rename;
  rm?: typeof rm;
}

export interface ActivateProviderFirstShadowDbParams {
  activeDbPath?: string | null;
  shadowDbPath?: string | null;
  generationId: string;
  now?: Date;
  fs?: ProviderFirstShadowActivationFs;
}

export interface ActivateProviderFirstShadowDbWithHandoffParams
  extends ActivateProviderFirstShadowDbParams {
  closeActiveDb: () => Promise<void>;
  reopenActiveDb: (activeDbPath: string) => Promise<void>;
  validateActivatedDb?: (activeDbPath: string) => Promise<void>;
}

export function summarizeProviderFirstShadowActivationReadiness(
  params: ProviderFirstShadowActivationReadinessParams,
): ProviderFirstShadowActivationSummary {
  const reasons: string[] = [];
  const shadowDb =
    params.shadowBuild?.status === "staged"
      ? params.shadowBuild.shadowDb
      : undefined;
  if (!shadowDb || shadowDb.status !== "loaded") {
    reasons.push("shadow DB was not loaded");
  }
  if (params.fallbackFiles > 0) {
    reasons.push("legacy fallback rows are not staged into the shadow DB yet");
  }
  if (!params.graphDerivedStateReady) {
    reasons.push("graph-derived state is not ready in the shadow DB yet");
  }
  if (!params.shadowContainsFinalizedGraph) {
    if (params.finalizedGraphReasons && params.finalizedGraphReasons.length > 0) {
      reasons.push(...params.finalizedGraphReasons);
    } else {
      reasons.push(
        "shadow DB does not contain version, metrics, summaries, and derived-state rows yet",
      );
    }
  }

  if (reasons.length > 0) {
    return {
      status: "skipped",
      shadowDbPath:
        shadowDb?.status === "loaded" ? shadowDb.path : undefined,
      rollback: "notNeeded",
      reasons,
    };
  }

  return {
    status: "skipped",
    shadowDbPath: shadowDb?.path,
    rollback: "notNeeded",
    reasons: ["shadow DB activation was not attempted for this run"],
  };
}

export async function activateProviderFirstShadowDb(
  params: ActivateProviderFirstShadowDbParams,
): Promise<ProviderFirstShadowActivationSummary> {
  const startedAt = Date.now();
  const activeDbPath = params.activeDbPath
    ? normalizePath(params.activeDbPath)
    : undefined;
  const shadowDbPath = params.shadowDbPath
    ? normalizePath(params.shadowDbPath)
    : undefined;
  if (!activeDbPath || !shadowDbPath) {
    return {
      status: "skipped",
      activeDbPath,
      shadowDbPath,
      rollback: "notNeeded",
      reasons: ["active and shadow LadybugDB paths are required for activation"],
    };
  }

  const ops = {
    access: params.fs?.access ?? access,
    rename: params.fs?.rename ?? rename,
    rm: params.fs?.rm ?? rm,
  };
  const previousDbPath = normalizePath(
    join(
      dirname(activeDbPath),
      `${basename(activeDbPath)}.provider-first-backup-${safePathSegment(params.generationId)}`,
    ),
  );
  const activatedAt = (params.now ?? new Date()).toISOString();

  try {
    await ops.access(shadowDbPath);
  } catch (err) {
    return {
      status: "skipped",
      activeDbPath,
      shadowDbPath,
      rollback: "notNeeded",
      reasons: [`shadow LadybugDB path is not readable: ${errorMessage(err)}`],
    };
  }

  await ops.rm(previousDbPath, { recursive: true, force: true });

  let activeMoved = false;
  try {
    await ops.rename(activeDbPath, previousDbPath);
    activeMoved = true;
  } catch (err) {
    return {
      status: "failed",
      activeDbPath,
      shadowDbPath,
      previousDbPath,
      rollback: "notNeeded",
      reasons: [
        `active LadybugDB path could not be moved; close SDL-MCP processes and retry activation: ${errorMessage(err)}`,
      ],
    };
  }

  try {
    await ops.rename(shadowDbPath, activeDbPath);
    return {
      status: "activated",
      activeDbPath,
      shadowDbPath,
      previousDbPath,
      activatedAt,
      durationMs: Date.now() - startedAt,
      rollback: "notNeeded",
      reasons: [],
    };
  } catch (err) {
    const activationError = errorMessage(err);
    let rollback: ProviderFirstShadowActivationRollbackStatus = "notNeeded";
    if (activeMoved) {
      try {
        await ops.rename(previousDbPath, activeDbPath);
        rollback = "restored";
      } catch {
        rollback = "failed";
      }
    }
    return {
      status: "failed",
      activeDbPath,
      shadowDbPath,
      previousDbPath,
      durationMs: Date.now() - startedAt,
      rollback,
      reasons: [
        `shadow LadybugDB path could not be activated: ${activationError}`,
      ],
    };
  }
}

export async function activateProviderFirstShadowDbWithHandoff(
  params: ActivateProviderFirstShadowDbWithHandoffParams,
): Promise<ProviderFirstShadowActivationSummary> {
  const activeDbPath = params.activeDbPath
    ? normalizePath(params.activeDbPath)
    : undefined;
  const shadowDbPath = params.shadowDbPath
    ? normalizePath(params.shadowDbPath)
    : undefined;
  if (!activeDbPath || !shadowDbPath) {
    return {
      status: "skipped",
      activeDbPath,
      shadowDbPath,
      rollback: "notNeeded",
      reasons: ["active and shadow LadybugDB paths are required for activation"],
    };
  }

  const accessPath = params.fs?.access ?? access;

  try {
    await accessPath(shadowDbPath);
  } catch (err) {
    return {
      status: "skipped",
      activeDbPath,
      shadowDbPath,
      rollback: "notNeeded",
      reasons: [`shadow LadybugDB path is not readable: ${errorMessage(err)}`],
    };
  }

  try {
    await params.closeActiveDb();
  } catch (err) {
    return {
      status: "failed",
      activeDbPath,
      shadowDbPath,
      rollback: "notNeeded",
      reasons: [`active LadybugDB could not be closed: ${errorMessage(err)}`],
    };
  }

  const activation = await activateProviderFirstShadowDb({
    activeDbPath,
    shadowDbPath,
    generationId: params.generationId,
    now: params.now,
    fs: params.fs,
  });

  if (activation.status !== "activated") {
    return reopenAfterFailedActivation(params, activation, activeDbPath);
  }

  try {
    await params.reopenActiveDb(activeDbPath);
    await params.validateActivatedDb?.(activeDbPath);
    return activation;
  } catch (err) {
    const reopenReason = `activated shadow LadybugDB could not be reopened or validated; rolling back to previous active DB: ${errorMessage(err)}`;
    return rollbackAfterReopenFailure({
      params,
      activation,
      activeDbPath,
      reopenReason,
    });
  }
}

async function reopenAfterFailedActivation(
  params: ActivateProviderFirstShadowDbWithHandoffParams,
  activation: ProviderFirstShadowActivationSummary,
  activeDbPath: string,
): Promise<ProviderFirstShadowActivationSummary> {
  try {
    await params.reopenActiveDb(activeDbPath);
    return activation;
  } catch (err) {
    return {
      ...activation,
      status: "failed",
      rollback: activation.rollback ?? "notNeeded",
      reasons: [
        ...activation.reasons,
        `active LadybugDB could not be reopened after failed activation: ${errorMessage(err)}`,
      ],
    };
  }
}

async function rollbackAfterReopenFailure(params: {
  params: ActivateProviderFirstShadowDbWithHandoffParams;
  activation: ProviderFirstShadowActivationSummary;
  activeDbPath: string;
  reopenReason: string;
}): Promise<ProviderFirstShadowActivationSummary> {
  const previousDbPath = params.activation.previousDbPath;
  if (!previousDbPath) {
    return {
      ...params.activation,
      status: "failed",
      rollback: "failed",
      reasons: [params.reopenReason],
    };
  }

  try {
    await params.params.closeActiveDb();
  } catch {
    // Best-effort: activation validation failed before a usable pool existed.
  }

  const rollback = await activateProviderFirstShadowDb({
    activeDbPath: params.activeDbPath,
    shadowDbPath: previousDbPath,
    generationId: `${params.params.generationId}-reopen-rollback`,
    fs: params.params.fs,
  });
  if (rollback.status === "activated") {
    try {
      await params.params.reopenActiveDb(params.activeDbPath);
      return {
        ...params.activation,
        status: "failed",
        rollback: "restored",
        reasons: [params.reopenReason, "previous active DB was restored"],
      };
    } catch (err) {
      return {
        ...params.activation,
        status: "failed",
        rollback: "failed",
        reasons: [
          params.reopenReason,
          `previous active DB was restored but could not be reopened: ${errorMessage(err)}`,
        ],
      };
    }
  }

  // A nested "restored" only restores the failed rollback swap's source; it
  // does not mean the original active DB was restored from previousDbPath.
  return {
    ...params.activation,
    status: "failed",
    rollback: "failed",
    reasons: [
      params.reopenReason,
      `previous active DB could not be restored: ${rollback.reasons.join("; ")}`,
    ],
  };
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  const trimmed = sanitized.replace(/^-+|-+$/g, "");
  return trimmed || "generation";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
