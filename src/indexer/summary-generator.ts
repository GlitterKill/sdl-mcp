import { hashContent } from "../util/hashing.js";

export interface GeneratedSummaryResult {
  summary: string;
  provider: string;
  costUsd: number;
  divergenceScore: number;
}

export interface SummaryProvider {
  name: string;
  generate(input: { symbolName: string; heuristicSummary?: string }): Promise<string>;
}

class MockSummaryProvider implements SummaryProvider {
  name = "mock";

  async generate(input: {
    symbolName: string;
    heuristicSummary?: string;
  }): Promise<string> {
    if (input.heuristicSummary && input.heuristicSummary.trim().length > 0) {
      return input.heuristicSummary;
    }
    return `${input.symbolName} participates in repository control flow and dependencies.`;
  }
}

export function createSummaryProvider(_provider: string): SummaryProvider {
  return new MockSummaryProvider();
}

function tokenDistance(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (aTokens.size === 0 && bTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      overlap += 1;
    }
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return 1 - overlap / Math.max(1, union);
}

export async function generateSummaryWithGuardrails(input: {
  symbolName: string;
  heuristicSummary?: string;
  provider: string;
}): Promise<GeneratedSummaryResult> {
  const summaryProvider = createSummaryProvider(input.provider);
  const summary = await summaryProvider.generate({
    symbolName: input.symbolName,
    heuristicSummary: input.heuristicSummary,
  });

  const divergenceScore = tokenDistance(summary, input.heuristicSummary ?? "");
  const estimatedTokens = Math.max(1, Math.ceil(summary.length / 4));
  const costUsd = estimatedTokens * 0.000002;

  return {
    summary,
    provider: summaryProvider.name,
    costUsd,
    divergenceScore,
  };
}

export function summaryCacheKey(symbolId: string, provider: string): string {
  return hashContent(`${symbolId}:${provider}`);
}
