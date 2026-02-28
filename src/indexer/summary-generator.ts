import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  getSummaryCache,
  upsertSummaryCache,
  getSymbolsByRepo,
  updateSymbolSummary,
} from "../db/queries.js";
import type { AppConfig } from "../config/types.js";

export interface GeneratedSummaryResult {
  summary: string;
  provider: string;
  costUsd: number;
  divergenceScore: number;
}

export interface SummaryProvider {
  name: string;
  generate(input: {
    symbolName: string;
    kind?: string;
    signature?: string;
    heuristicSummary?: string;
  }): Promise<string>;
}

const ANTHROPIC_SYSTEM_PROMPT =
  "You are a code documentation assistant. Write a 1-3 sentence summary of what this TypeScript/JavaScript symbol does. Be specific, not generic. Focus on behavior, not structure.";

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

export class AnthropicSummaryProvider implements SummaryProvider {
  name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-haiku-4-5-20251001";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  }

  async generate(input: {
    symbolName: string;
    kind?: string;
    signature?: string;
    heuristicSummary?: string;
  }): Promise<string> {
    const parts: string[] = [];
    if (input.kind) {
      parts.push(`Kind: ${input.kind}`);
    }
    parts.push(`Name: ${input.symbolName}`);
    if (input.signature) {
      // Truncate signature to keep total well under 300 tokens
      const sig =
        input.signature.length > 400
          ? input.signature.slice(0, 400) + "..."
          : input.signature;
      parts.push(`Signature: ${sig}`);
    }
    if (input.heuristicSummary && input.heuristicSummary.trim().length > 0) {
      const hint =
        input.heuristicSummary.length > 200
          ? input.heuristicSummary.slice(0, 200) + "..."
          : input.heuristicSummary;
      parts.push(`Heuristic hint: ${hint}`);
    }
    const userContent = parts.join("\n");

    const url = `${this.baseUrl}/v1/messages`;
    const body = {
      model: this.model,
      max_tokens: 256,
      system: ANTHROPIC_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const truncated =
        rawBody.length > 200 ? rawBody.slice(0, 200) + "..." : rawBody;
      throw new Error(
        `Anthropic API error: HTTP ${response.status} - ${truncated}`,
      );
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = data?.content?.[0]?.text ?? "";
    return text.trim();
  }
}

export class OpenAICompatibleSummaryProvider implements SummaryProvider {
  name = "openai-compatible";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(
      /\/+$/,
      "",
    );
  }

  async generate(input: {
    symbolName: string;
    kind?: string;
    signature?: string;
    heuristicSummary?: string;
  }): Promise<string> {
    const parts: string[] = [];
    if (input.kind) {
      parts.push(`Kind: ${input.kind}`);
    }
    parts.push(`Name: ${input.symbolName}`);
    if (input.signature) {
      const sig =
        input.signature.length > 400
          ? input.signature.slice(0, 400) + "..."
          : input.signature;
      parts.push(`Signature: ${sig}`);
    }
    if (input.heuristicSummary && input.heuristicSummary.trim().length > 0) {
      const hint =
        input.heuristicSummary.length > 200
          ? input.heuristicSummary.slice(0, 200) + "..."
          : input.heuristicSummary;
      parts.push(`Heuristic hint: ${hint}`);
    }
    const userContent = parts.join("\n");

    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      max_tokens: 256,
      messages: [
        { role: "system", content: ANTHROPIC_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const truncated =
        rawBody.length > 200 ? rawBody.slice(0, 200) + "..." : rawBody;
      throw new Error(
        `OpenAI-compatible API error: HTTP ${response.status} - ${truncated}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content ?? "";
    return text.trim();
  }
}

export function createSummaryProvider(
  provider: string,
  options?: {
    summaryModel?: string;
    summaryApiKey?: string;
    summaryApiBaseUrl?: string;
  },
): SummaryProvider {
  if (provider === "api") {
    const apiKey =
      options?.summaryApiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!apiKey) {
      logger.warn(
        "No API key found for summary provider 'api'. Set ANTHROPIC_API_KEY or summaryApiKey config. Falling back to mock provider.",
      );
      return new MockSummaryProvider();
    }
    return new AnthropicSummaryProvider({
      apiKey,
      model: options?.summaryModel,
    });
  }

  if (provider === "local") {
    const apiKey =
      options?.summaryApiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "ollama";
    return new OpenAICompatibleSummaryProvider({
      apiKey,
      model: options?.summaryModel,
      baseUrl: options?.summaryApiBaseUrl,
    });
  }

  // "mock" or any unknown provider
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
  symbolId?: string;
  kind?: string;
  signature?: string;
  heuristicSummary?: string;
  provider: string;
  summaryModel?: string;
  summaryApiKey?: string;
  summaryApiBaseUrl?: string;
}): Promise<GeneratedSummaryResult> {
  const summaryProvider = createSummaryProvider(input.provider, {
    summaryModel: input.summaryModel,
    summaryApiKey: input.summaryApiKey,
    summaryApiBaseUrl: input.summaryApiBaseUrl,
  });

  // Compute card hash for cache keying
  const cardHash = hashContent(
    [input.symbolName, input.kind ?? "", input.signature ?? ""].join("|"),
  );

  // Check summary cache when symbolId is available
  if (input.symbolId) {
    const cached = getSummaryCache(input.symbolId);
    if (cached != null && cached.card_hash === cardHash) {
      const divergenceScore = tokenDistance(
        cached.summary,
        input.heuristicSummary ?? "",
      );
      const estimatedTokens = Math.max(1, Math.ceil(cached.summary.length / 4));
      const costUsd = estimatedTokens * 0.000002;
      return {
        summary: cached.summary,
        provider: cached.provider,
        costUsd,
        divergenceScore,
      };
    }
  }

  const summary = await summaryProvider.generate({
    symbolName: input.symbolName,
    kind: input.kind,
    signature: input.signature,
    heuristicSummary: input.heuristicSummary,
  });

  const divergenceScore = tokenDistance(summary, input.heuristicSummary ?? "");
  const estimatedTokens = Math.max(1, Math.ceil(summary.length / 4));
  const costUsd = estimatedTokens * 0.000002;

  // Persist to cache when symbolId is available
  if (input.symbolId) {
    const now = new Date().toISOString();
    upsertSummaryCache({
      symbol_id: input.symbolId,
      summary,
      provider: summaryProvider.name,
      model: input.summaryModel ?? summaryProvider.name,
      card_hash: cardHash,
      cost_usd: costUsd,
      created_at: now,
      updated_at: now,
    });
  }

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

// ---------------------------------------------------------------------------
// Batch summary generation
// ---------------------------------------------------------------------------

export interface SummaryBatchResult {
  generated: number;
  skipped: number;
  failed: number;
  totalCostUsd: number;
}

/**
 * Generates AI summaries for all symbols in a repository that need them.
 * Symbols with a fresh cache entry (matching cardHash) are skipped.
 * Symbols whose current summary looks like the heuristic default pattern
 * ("% participates in %") or that have no cache entry are processed.
 *
 * Processing happens in batches of `summaryBatchSize` with up to
 * `summaryMaxConcurrency` concurrent batches.
 */
export async function generateSummariesForRepo(
  repoId: string,
  config: AppConfig,
): Promise<SummaryBatchResult> {
  const semantic = config.semantic;
  if (!semantic) {
    return { generated: 0, skipped: 0, failed: 0, totalCostUsd: 0 };
  }

  const batchSize = semantic.summaryBatchSize ?? 20;
  const maxConcurrency = semantic.summaryMaxConcurrency ?? 5;
  const provider = semantic.provider ?? "mock";
  const summaryModel = semantic.summaryModel;
  const summaryApiKey = semantic.summaryApiKey;
  const summaryApiBaseUrl = semantic.summaryApiBaseUrl;

  // Fetch all symbols for the repo
  const symbols = getSymbolsByRepo(repoId);

  // Determine which symbols need a new summary by checking the cache
  const needsSummary = symbols.filter((sym) => {
    const cardHash = hashContent(
      [sym.name, sym.kind ?? "", sym.signature_json ?? ""].join("|"),
    );
    const cached = getSummaryCache(sym.symbol_id);
    // Skip if cache entry exists and cardHash matches
    if (cached != null && cached.card_hash === cardHash) {
      return false;
    }
    return true;
  });

  const result: SummaryBatchResult = {
    generated: 0,
    skipped: symbols.length - needsSummary.length,
    failed: 0,
    totalCostUsd: 0,
  };

  if (needsSummary.length === 0) {
    return result;
  }

  // Split into batches
  const batches: typeof needsSummary[] = [];
  for (let i = 0; i < needsSummary.length; i += batchSize) {
    batches.push(needsSummary.slice(i, i + batchSize));
  }

  // Process batches with limited concurrency
  let batchIndex = 0;

  const processBatch = async (
    batch: typeof needsSummary,
  ): Promise<{ generated: number; failed: number; costUsd: number }> => {
    let batchGenerated = 0;
    let batchFailed = 0;
    let batchCost = 0;

    for (const sym of batch) {
      try {
        const signatureText = sym.signature_json
          ? (() => {
              try {
                const parsed = JSON.parse(sym.signature_json) as
                  | { text?: string }
                  | string;
                return typeof parsed === "string"
                  ? parsed
                  : (parsed?.text ?? sym.signature_json);
              } catch {
                return sym.signature_json;
              }
            })()
          : undefined;

        const genResult = await generateSummaryWithGuardrails({
          symbolName: sym.name,
          symbolId: sym.symbol_id,
          kind: sym.kind,
          signature: signatureText,
          heuristicSummary: sym.summary ?? undefined,
          provider,
          summaryModel,
          summaryApiKey: summaryApiKey ?? undefined,
          summaryApiBaseUrl: summaryApiBaseUrl ?? undefined,
        });

        // Update the symbol row with the new summary
        updateSymbolSummary(sym.symbol_id, genResult.summary);

        batchGenerated += 1;
        batchCost += genResult.costUsd;
      } catch (err) {
        logger.warn(
          `Failed to generate summary for symbol ${sym.symbol_id}: ${String(err)}`,
        );
        batchFailed += 1;
      }
    }

    return { generated: batchGenerated, failed: batchFailed, costUsd: batchCost };
  };

  // Run batches with maxConcurrency slots
  while (batchIndex < batches.length) {
    const chunk = batches.slice(batchIndex, batchIndex + maxConcurrency);
    batchIndex += maxConcurrency;

    const settled = await Promise.allSettled(chunk.map((b) => processBatch(b)));

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        result.generated += outcome.value.generated;
        result.failed += outcome.value.failed;
        result.totalCostUsd += outcome.value.costUsd;
      } else {
        // Entire batch threw — count all as failed
        result.failed += chunk[0]?.length ?? 0;
        logger.warn(`Batch failed entirely: ${String(outcome.reason)}`);
      }
    }
  }

  return result;
}
