import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";

import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import {
  BufferCheckpointRequestSchema,
  type BufferCheckpointResponse,
  BufferPushRequestSchema,
  type BufferPushRequest,
  type BufferPushResponse,
  BufferStatusRequestSchema,
  type BufferStatusResponse,
} from "../tools.js";
import { ValidationError, IndexError, NotFoundError } from "../errors.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";
import type { ToolContext } from "../../server.js";
import { logger } from "../../util/logger.js";
import { withRepoMutation } from "../../services/repo-lifecycle.js";

function resolveLiveIndex(
  liveIndex?: LiveIndexCoordinator,
): LiveIndexCoordinator {
  const coordinator = liveIndex ?? getDefaultLiveIndexCoordinator();
  if (!coordinator) {
    throw new IndexError("Live index coordinator is not available");
  }
  return coordinator;
}

const bufferPushQueues = new Map<string, Promise<unknown>>();

async function runSerializedBufferPush<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = bufferPushQueues.get(key) ?? Promise.resolve();
  const tracked = previous.catch(() => undefined).then(operation);
  const queue = tracked.finally(() => {
    if (bufferPushQueues.get(key) === queue) {
      bufferPushQueues.delete(key);
    }
  });
  bufferPushQueues.set(key, queue);
  return queue;
}

async function appendMissingFileWarning(
  request: BufferPushRequest,
  pushed: BufferPushResponse,
): Promise<BufferPushResponse> {
  try {
    const conn = await getLadybugConn();
    const repo = await ladybugDb.getRepo(conn, request.repoId);
    if (!repo) {
      logger.warn("Buffer push repo not found", {
        repoId: request.repoId,
        filePath: request.filePath,
      });
      return pushed;
    }

    const absPath = resolve(repo.rootPath, request.filePath);
    if (!existsSync(absPath)) {
      return {
        ...pushed,
        warnings: [
          ...(pushed.warnings ?? []),
          `File does not exist on disk: ${request.filePath}`,
        ],
      };
    }
  } catch (error) {
    // The disk check is advisory. A live buffer update should not fail just
    // because repository metadata is unavailable in tests or during startup.
    logger.debug("Skipping buffer push file existence warning", {
      repoId: request.repoId,
      filePath: request.filePath,
      error,
    });
  }

  return pushed;
}

export async function handleBufferPush(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferPushResponse> {
  try {
    // Coerce numeric timestamp (epoch ms) to ISO string before validation
    const normalized = args != null && typeof args === "object" && "timestamp" in args && typeof (args as Record<string, unknown>).timestamp === "number"
      ? { ...args as Record<string, unknown>, timestamp: new Date((args as Record<string, unknown>).timestamp as number).toISOString() }
      : args;
    const request = parseActionHandlerArgs(BufferPushRequestSchema, normalized);
    const result = await withRepoMutation(request.repoId, async () =>
      request.filePath
        ? runSerializedBufferPush(
            `${request.repoId}\0${request.filePath}`,
            async () => {
              const pushed = await resolveLiveIndex(
                liveIndex,
              ).pushBufferUpdate(request);
              return appendMissingFileWarning(request, pushed);
            },
          )
        : resolveLiveIndex(liveIndex).pushBufferUpdate(request),
    );
    return result;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer push request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (
      error instanceof ValidationError ||
      error instanceof IndexError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    throw new IndexError("Buffer push failed");
  }
}

export async function handleBufferCheckpoint(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferCheckpointResponse> {
  try {
    const request = parseActionHandlerArgs(BufferCheckpointRequestSchema, args);
    const result = await withRepoMutation(request.repoId, () =>
      resolveLiveIndex(liveIndex).checkpointRepo(request),
    );
    // Surface a clear pending flag so callers know whether to poll buffer.status.
    const pending =
    result.pendingBuffers > 0 &&
    (result.requested === true || result.checkpointId === "in-progress");
    return { ...result, pending };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer checkpoint request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (
      error instanceof ValidationError ||
      error instanceof IndexError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    throw new IndexError("Buffer checkpoint failed");
  }
}

export function compactBufferStatusForAgent(
  status: BufferStatusResponse,
): BufferStatusResponse {
  const compact: BufferStatusResponse = {
    repoId: status.repoId,
    enabled: status.enabled,
    pendingBuffers: status.pendingBuffers,
    dirtyBuffers: status.dirtyBuffers,
    parseQueueDepth: status.parseQueueDepth,
    checkpointPending: status.checkpointPending,
    lastBufferEventAt: status.lastBufferEventAt,
    lastCheckpointAt: status.lastCheckpointAt,
  };
  if (status.lastCheckpointAttemptAt != null) compact.lastCheckpointAttemptAt = status.lastCheckpointAttemptAt;
  if (status.lastCheckpointResult != null) compact.lastCheckpointResult = status.lastCheckpointResult;
  if (status.lastCheckpointError != null) compact.lastCheckpointError = status.lastCheckpointError;
  if (status.lastCheckpointReason != null) compact.lastCheckpointReason = status.lastCheckpointReason;
  if (status.reconcileQueueDepth !== undefined) compact.reconcileQueueDepth = status.reconcileQueueDepth;
  if (status.oldestReconcileAt != null) compact.oldestReconcileAt = status.oldestReconcileAt;
  if (status.lastReconciledAt != null) compact.lastReconciledAt = status.lastReconciledAt;
  if (status.reconcileInflight !== undefined) compact.reconcileInflight = status.reconcileInflight;
  if (status.reconcileLastError != null) compact.reconcileLastError = status.reconcileLastError;
  return compact;
}

export async function handleBufferStatus(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferStatusResponse> {
  try {
    const request = parseActionHandlerArgs(BufferStatusRequestSchema, args);
    const status = await resolveLiveIndex(liveIndex).getLiveStatus(request.repoId);
    return compactBufferStatusForAgent(status);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer status request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError("Buffer status failed");
  }
}
