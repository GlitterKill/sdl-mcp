import { contextEngine } from "../../agent/context-engine.js";
import type { AgentTask } from "../../agent/types.js";
import { IndexError, ValidationError } from "../errors.js";
import { attachRawContext } from "../token-usage.js";
import {
  AgentContextRequestSchema,
  type AgentContextResponse,
} from "../tools.js";
import { ZodError } from "zod";

export async function handleAgentContext(
  args: unknown,
): Promise<AgentContextResponse> {
  try {
    const request = AgentContextRequestSchema.parse(args);
    const task: AgentTask = {
      repoId: request.repoId,
      taskType: request.taskType,
      taskText: request.taskText,
      budget: request.budget,
      options: request.options,
    };

    const result = await contextEngine.buildContext(task);
    const response = result as AgentContextResponse;

    const focusPaths = request.options?.focusPaths;
    const fileIds = focusPaths?.length
      ? focusPaths.map((path) => `${request.repoId}:${path}`)
      : undefined;
    return attachRawContext(
      response,
      fileIds ? { fileIds } : { rawTokens: response.metrics.totalTokens * 3 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid agent context request: ${error.issues.map((issue) => issue.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Agent context retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
