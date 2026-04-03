import {
  ContextSummaryRequestSchema,
  ContextSummaryResponse,
} from "../tools.js";
import {
  generateContextSummary,
  renderContextSummary,
} from "../../services/summary.js";
import { ValidationError, IndexError } from "../errors.js";
import { ZodError } from "zod";
import { buildConditionalResponse } from "../../util/conditional-response.js";

export async function handleContextSummary(
  args: unknown,
): Promise<ContextSummaryResponse> {
  try {
    const request = ContextSummaryRequestSchema.parse(args);
    const summary = await generateContextSummary({
      repoId: request.repoId,
      query: request.query,
      budget: request.budget,
      scope: request.scope,
    });

    const format = request.format ?? "markdown";
    return buildConditionalResponse({
      repoId: request.repoId,
      format,
      summary,
      content: renderContextSummary(summary, format),
    }, {
      ifNoneMatch: request.ifNoneMatch,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid context summary request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Context summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
