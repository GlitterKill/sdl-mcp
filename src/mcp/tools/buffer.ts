import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";

import {
  BufferCheckpointRequestSchema,
  type BufferCheckpointResponse,
  BufferPushRequestSchema,
  type BufferPushResponse,
  BufferStatusRequestSchema,
  type BufferStatusResponse,
} from "../tools.js";
import { ValidationError, IndexError } from "../errors.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";
import type { ToolContext } from "../../server.js";
import { logger } from "../../util/logger.js";

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
    const request = BufferPushRequestSchema.parse(normalized);
    const result = request.filePath
      ? await runSerializedBufferPush(
          `${request.repoId}\0${request.filePath}`,
          async () => {
            const pushed = await resolveLiveIndex(liveIndex).pushBufferUpdate(request);
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
              pushed.warnings = [
                ...(pushed.warnings ?? []),
                `File does not exist on disk: ${request.filePath}`,
              ];
            }
            return pushed;
          },
        )
      : await resolveLiveIndex(liveIndex).pushBufferUpdate(request);
    return result;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer push request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
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
    const request = BufferCheckpointRequestSchema.parse(args);
    const result = await resolveLiveIndex(liveIndex).checkpointRepo(request);
    // Surface a clear pending flag so callers know whether to poll buffer.status.
    const pending = result.requested === true && result.pendingBuffers > 0;
    return { ...result, pending };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer checkpoint request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError("Buffer checkpoint failed");
  }
}

export async function handleBufferStatus(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferStatusResponse> {
  try {
    const request = BufferStatusRequestSchema.parse(args);
    return await resolveLiveIndex(liveIndex).getLiveStatus(request.repoId);
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
