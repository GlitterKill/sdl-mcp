import { orchestrator } from "../../agent/orchestrator.js";
import type { AgentTask } from "../../agent/types.js";
import { attachRawContext } from "../token-usage.js";
import {
  AgentOrchestrateRequestSchema,
  type AgentOrchestrateResponse,
} from "../tools.js";
import { ValidationError, IndexError } from "../errors.js";
import { ZodError } from "zod";

export async function handleAgentOrchestrate(
  args: unknown,
): Promise<AgentOrchestrateResponse> {
  try {
    const request = AgentOrchestrateRequestSchema.parse(args);
    const task: AgentTask = {
      repoId: request.repoId,
      taskType: request.taskType,
      taskText: request.taskText,
      budget: request.budget,
      options: request.options,
    };

    const result = await orchestrator.orchestrate(task);
    // OrchestrationResult and AgentOrchestrateResponse are structurally identical.
    // If either type changes, update both to maintain compatibility.
    const response = result as AgentOrchestrateResponse;
    attachRawContext(response, { rawTokens: response.metrics.totalTokens * 3 });
    return response;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid agent orchestrate request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Agent orchestration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
