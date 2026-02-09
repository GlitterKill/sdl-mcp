import { z } from "zod";
import { orchestrator } from "../../agent/orchestrator.js";
import type { AgentTask } from "../../agent/types.js";

export const AgentOrchestrateRequestSchema = z.object({
  repoId: z.string().describe("Repository ID to work with"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task to perform"),
  taskText: z.string().describe("Task description or prompt"),
  budget: z
    .object({
      maxTokens: z.number().optional().describe("Maximum tokens to consume"),
      maxActions: z
        .number()
        .optional()
        .describe("Maximum number of actions to execute"),
      maxDurationMs: z
        .number()
        .optional()
        .describe("Maximum duration in milliseconds"),
    })
    .optional()
    .describe("Budget constraints for the task"),
  options: z
    .object({
      focusSymbols: z
        .array(z.string())
        .optional()
        .describe("List of symbol IDs to focus on"),
      focusPaths: z
        .array(z.string())
        .optional()
        .describe("List of file paths to focus on"),
      includeTests: z
        .boolean()
        .optional()
        .describe("Whether to include test files"),
      requireDiagnostics: z
        .boolean()
        .optional()
        .describe("Whether to require diagnostic information"),
    })
    .optional()
    .describe("Task-specific options"),
});

export const AgentOrchestrateResponseSchema = z.object({
  taskId: z.string().describe("Unique task identifier"),
  taskType: z
    .enum(["debug", "review", "implement", "explain"])
    .describe("Type of task performed"),
  actionsTaken: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        status: z.enum(["pending", "inProgress", "completed", "failed"]),
        input: z.record(z.any()),
        output: z.any().optional(),
        error: z.string().optional(),
        timestamp: z.number(),
        durationMs: z.number(),
        evidence: z.array(z.any()),
      }),
    )
    .describe("Actions taken during execution"),
  path: z
    .object({
      rungs: z.array(z.enum(["card", "skeleton", "hotPath", "raw"])),
      estimatedTokens: z.number(),
      estimatedDurationMs: z.number(),
      reasoning: z.string(),
    })
    .describe("Rung path selected for execution"),
  finalEvidence: z
    .array(
      z.object({
        type: z.string(),
        reference: z.string(),
        summary: z.string(),
        timestamp: z.number(),
      }),
    )
    .describe("Evidence collected during execution"),
  summary: z.string().describe("Summary of execution"),
  success: z.boolean().describe("Whether execution was successful"),
  error: z.string().optional().describe("Error message if execution failed"),
  metrics: z
    .object({
      totalDurationMs: z.number(),
      totalTokens: z.number(),
      totalActions: z.number(),
      successfulActions: z.number(),
      failedActions: z.number(),
      cacheHits: z.number(),
    })
    .describe("Execution metrics"),
  answer: z
    .string()
    .optional()
    .describe("Answer to the task based on collected evidence"),
  nextBestAction: z
    .string()
    .optional()
    .describe(
      "Suggested next action based on execution results and policy decisions",
    ),
});

export type AgentOrchestrateRequest = z.infer<
  typeof AgentOrchestrateRequestSchema
>;
export type AgentOrchestrateResponse = z.infer<
  typeof AgentOrchestrateResponseSchema
>;

export async function handleAgentOrchestrate(
  args: unknown,
): Promise<AgentOrchestrateResponse> {
  const request = AgentOrchestrateRequestSchema.parse(args);
  const task: AgentTask = {
    repoId: request.repoId,
    taskType: request.taskType,
    taskText: request.taskText,
    budget: request.budget,
    options: request.options,
  };

  const result = await orchestrator.orchestrate(task);

  return result as AgentOrchestrateResponse;
}
