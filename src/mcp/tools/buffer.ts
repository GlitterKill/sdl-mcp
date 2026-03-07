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

function resolveLiveIndex(
  liveIndex?: LiveIndexCoordinator,
): LiveIndexCoordinator {
  return liveIndex ?? getDefaultLiveIndexCoordinator();
}

export async function handleBufferPush(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferPushResponse> {
  const request = BufferPushRequestSchema.parse(args);
  return resolveLiveIndex(liveIndex).pushBufferUpdate(request);
}

export async function handleBufferCheckpoint(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferCheckpointResponse> {
  const request = BufferCheckpointRequestSchema.parse(args);
  return resolveLiveIndex(liveIndex).checkpointRepo(request);
}

export async function handleBufferStatus(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<BufferStatusResponse> {
  const request = BufferStatusRequestSchema.parse(args);
  return resolveLiveIndex(liveIndex).getLiveStatus(request.repoId);
}
