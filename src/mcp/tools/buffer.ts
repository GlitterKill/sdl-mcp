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
    return await resolveLiveIndex(liveIndex).pushBufferUpdate(request);
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
