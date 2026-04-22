import {
  BufferCheckpointRequestSchema,
  type BufferCheckpointResponse,
  BufferPushRequestSchema,
  type BufferPushResponse,
  BufferStatusRequestSchema,
  type BufferStatusResponse,
} from "../tools.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";
import type { ToolContext } from "../../server.js";
import { ValidationError, IndexError } from "../errors.js";
import { ZodError } from "zod";

function resolveLiveIndex(
  liveIndex?: LiveIndexCoordinator,
): LiveIndexCoordinator {
  const coordinator = liveIndex ?? getDefaultLiveIndexCoordinator();
  if (!coordinator) {
    throw new IndexError("Live index coordinator is not available");
  }
  return coordinator;
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
    const result = await resolveLiveIndex(liveIndex).pushBufferUpdate(request);
    // Warn if file does not exist on disk
    if (request.filePath) {
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const config = (await import("../../config/loadConfig.js")).loadConfig();
      const repo = config.repos?.find((r: { repoId?: string }) => r.repoId === request.repoId) ?? config.repos?.[0];
      if (repo?.rootPath) {
        const absPath = resolve(repo.rootPath, request.filePath);
        if (!existsSync(absPath)) {
          result.warnings = [...(result.warnings ?? []), `File does not exist on disk: ${request.filePath}`];
        }
      }
    }
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
    throw new IndexError(
      `Buffer push failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleBufferCheckpoint(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferCheckpointResponse> {
  try {
    const request = BufferCheckpointRequestSchema.parse(args);
    return await resolveLiveIndex(liveIndex).checkpointRepo(request);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid buffer checkpoint request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Buffer checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    throw new IndexError(
      `Buffer status failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
