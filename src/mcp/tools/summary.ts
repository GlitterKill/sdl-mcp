import {
  ContextSummaryRequestSchema,
  ContextSummaryResponse,
} from "../tools.js";
import {
  generateContextSummary,
  renderContextSummary,
} from "../summary.js";

export async function handleContextSummary(
  args: unknown,
): Promise<ContextSummaryResponse> {
  const request = ContextSummaryRequestSchema.parse(args);
  const summary = generateContextSummary({
    repoId: request.repoId,
    query: request.query,
    budget: request.budget,
    scope: request.scope,
  });

  const format = request.format ?? "markdown";
  return {
    repoId: request.repoId,
    format,
    summary,
    content: renderContextSummary(summary, format),
  };
}

