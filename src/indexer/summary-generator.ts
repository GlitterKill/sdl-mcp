import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { AppConfig } from "../config/types.js";
import type { IndexProgress } from "./indexer.js";
import {
  prepareSymbolEmbeddingInputs,
  type PreparedSymbolEmbeddingInput,
} from "./symbol-embedding-context.js";
import {
  buildConciseSymbolSummary,
  CONCISE_SYMBOL_SUMMARY_BUILDER_VERSION,
} from "./symbol-embedding-text.js";
import { isMetadataProseTemplate } from "./summaries.js";

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
    embeddingInput?: PreparedSymbolEmbeddingInput;
  }): Promise<string>;
}

const ANTHROPIC_SYSTEM_PROMPT =
  "You are a code documentation assistant. Write a 1-3 sentence summary of what this TypeScript/JavaScript symbol does. Be specific, not generic. Focus on behavior, not structure.";

function buildFallbackPreparedInput(input: {
  symbolName: string;
  kind?: string;
  signature?: string;
}): PreparedSymbolEmbeddingInput {
  return {
    symbol: {
      name: input.symbolName,
      kind: input.kind ?? "symbol",
    } as PreparedSymbolEmbeddingInput["symbol"],
    signatureText: input.signature ?? null,
    relPath: null,
    language: null,
    roleTags: [],
    searchTerms: [],
    invariants: [],
    sideEffects: [],
    imports: [],
    calls: [],
    summaryFreshness: "absent",
    summaryText: null,
  };
}

class MockSummaryProvider implements SummaryProvider {
  name = "mock";

  async generate(input: {
    symbolName: string;
    kind?: string;
    signature?: string;
    embeddingInput?: PreparedSymbolEmbeddingInput;
  }): Promise<string> {
    return buildConciseSymbolSummary(
      input.embeddingInput ?? buildFallbackPreparedInput(input),
    );
  }
}

export class AnthropicSummaryProvider implements SummaryProvider {
  name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; model?: string; baseUrl?: string }) {
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

  constructor(options: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = (options.baseUrl ?? "http://localhost:11434/v1").replace(
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
): SummaryProvider | null {
  if (provider === "api") {
    const apiKey =
      options?.summaryApiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!apiKey) {
      logger.warn(
        "No API key found for summary provider 'api'. Set ANTHROPIC_API_KEY or summaryApiKey config. " +
          "Skipping summary generation to preserve existing summaries.",
      );
      return null;
    }
    return new AnthropicSummaryProvider({
      apiKey,
      model: options?.summaryModel,
      baseUrl: options?.summaryApiBaseUrl ?? undefined,
    });
  }

  if (provider === "local") {
    // Do NOT fall back to ANTHROPIC_API_KEY here — the local provider talks to
    // an OpenAI-compatible endpoint (e.g., Ollama) and sending the Anthropic
    // credential to an arbitrary summaryApiBaseUrl would be a security leak.
    const apiKey = options?.summaryApiKey ?? "ollama";
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

function firstSummaryContextValue(values: readonly string[] | undefined): string {
  for (const value of values ?? []) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return "";
}

function buildSummaryCardHash(input: {
  symbolName: string;
  kind?: string | null;
  signature?: string | null;
  astFingerprint?: string | null;
  providerName: string;
  modelName: string;
  embeddingInput?: PreparedSymbolEmbeddingInput;
}): string {
  const signatureText = input.embeddingInput?.signatureText ?? input.signature ?? "";
  if (input.providerName === "mock") {
    return hashContent(
      [
        input.symbolName,
        input.kind ?? "",
        input.providerName,
        input.modelName,
        CONCISE_SYMBOL_SUMMARY_BUILDER_VERSION,
        signatureText,
        firstSummaryContextValue(input.embeddingInput?.roleTags),
        firstSummaryContextValue(input.embeddingInput?.sideEffects),
      ].join("|"),
    );
  }

  return hashContent(
    [
      input.symbolName,
      input.kind ?? "",
      input.signature ?? "",
      input.astFingerprint ?? "",
      input.providerName,
      input.modelName,
    ].join("|"),
  );
}


function summaryStorageMetadata(providerName: string): {
  quality: number;
  source: string;
} {
  return providerName === "mock"
    ? { quality: 0.6, source: "heuristic-typed" }
    : { quality: 1.0, source: "llm" };
}

function isCodeFenceOnlySummary(summary: string | null | undefined): boolean {
  const trimmed = summary?.trim() ?? "";
  return trimmed === "```" || /^```[A-Za-z0-9_-]+$/.test(trimmed);
}

interface PendingSymbolSummaryUpdate {
  symbolId: string;
  summary: string | null;
  summaryQuality: number;
  summarySource: string;
}

function prepareCardSummaryForStorage(
  row: PendingSymbolSummaryUpdate,
): PendingSymbolSummaryUpdate {
  if (
    row.summary === null ||
    !isMetadataProseTemplate(row.summary, row.symbolId)
  ) {
    return row;
  }
  return {
    ...row,
    summary: null,
    summaryQuality: 0,
    summarySource: "filtered",
  };
}

interface PendingGeneratedSummary extends PendingSymbolSummaryUpdate {
  provider: string;
  model: string;
  cardHash: string;
  costUsd: number;
}

async function updateSymbolSummariesInTransaction(
  rows: readonly PendingSymbolSummaryUpdate[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await withWriteConn(async (wConn) => {
    await ladybugDb.withTransaction(wConn, async (txConn) => {
      const updatedAt = new Date().toISOString();
      for (const row of rows) {
        const cardRow = prepareCardSummaryForStorage(row);
        await ladybugDb.updateSymbolSummary(
          txConn,
          cardRow.symbolId,
          cardRow.summary,
          cardRow.summaryQuality,
          cardRow.summarySource,
          updatedAt,
        );
      }
    });
  });
}

async function persistGeneratedSummariesInTransaction(
  rows: readonly PendingGeneratedSummary[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await withWriteConn(async (wConn) => {
    await ladybugDb.withTransaction(wConn, async (txConn) => {
      const now = new Date().toISOString();
      for (const row of rows) {
        await ladybugDb.upsertSummaryCache(txConn, {
          symbolId: row.symbolId,
          summary: row.summary ?? "",
          provider: row.provider,
          model: row.model,
          cardHash: row.cardHash,
          costUsd: row.costUsd,
          createdAt: now,
          updatedAt: now,
        });
        const cardRow = prepareCardSummaryForStorage(row);
        await ladybugDb.updateSymbolSummary(
          txConn,
          cardRow.symbolId,
          cardRow.summary,
          cardRow.summaryQuality,
          cardRow.summarySource,
          now,
        );
      }
    });
  });
}



export async function generateSummaryWithGuardrails(input: {
  symbolName: string;
  symbolId?: string;
  kind?: string;
  signature?: string;
  astFingerprint?: string;
  heuristicSummary?: string;
  embeddingInput?: PreparedSymbolEmbeddingInput;
  provider: string;
  summaryModel?: string;
  summaryApiKey?: string;
  summaryApiBaseUrl?: string;
  skipCacheLookup?: boolean;
  persistCache?: boolean;
}): Promise<GeneratedSummaryResult> {

  const conn = await getLadybugConn();
  const summaryProvider = createSummaryProvider(input.provider, {
    summaryModel: input.summaryModel,
    summaryApiKey: input.summaryApiKey,
    summaryApiBaseUrl: input.summaryApiBaseUrl,
  });

  // If provider creation returned null (e.g., misconfigured local provider),
  // preserve existing summaries by returning cached value or empty result.
  if (summaryProvider == null) {
    if (input.symbolId) {
      const cached = await ladybugDb.getSummaryCache(conn, input.symbolId);
      if (cached != null) {
        return {
          summary: cached.summary,
          provider: cached.provider,
          costUsd: 0,
          divergenceScore: tokenDistance(
            cached.summary,
            input.heuristicSummary ?? "",
          ),
        };
      }
    }
    return { summary: "", provider: "skipped", costUsd: 0, divergenceScore: 0 };
  }

  // Compute card hash for cache keying. Mock summaries include only the concise
  // builder inputs that can change deterministic prose.
  const resolvedModel = input.summaryModel ?? summaryProvider.name;
  const cardHash = buildSummaryCardHash({
    symbolName: input.symbolName,
    kind: input.kind,
    signature: input.signature,
    astFingerprint: input.astFingerprint,
    providerName: summaryProvider.name,
    modelName: resolvedModel,
    embeddingInput: input.embeddingInput,
  });

  // Check summary cache when symbolId is available. Batch callers pass a bulk
  // cache snapshot and skip this standalone read.
  if (input.symbolId && input.skipCacheLookup !== true) {

    const cached = await ladybugDb.getSummaryCache(conn, input.symbolId);
    if (cached != null && cached.cardHash === cardHash) {
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
    embeddingInput: input.embeddingInput,
  });


  const divergenceScore = tokenDistance(summary, input.heuristicSummary ?? "");
  const estimatedTokens = Math.max(1, Math.ceil(summary.length / 4));
  const costUsd = estimatedTokens * 0.000002;

  // Persist to cache for standalone callers. Batch generation persists cache
  // and Symbol rows together in one transaction.
  if (input.symbolId && input.persistCache !== false) {

    const symbolId = input.symbolId;
    const now = new Date().toISOString();
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSummaryCache(wConn, {
        symbolId,
        summary,
        provider: summaryProvider.name,
        model: input.summaryModel ?? summaryProvider.name,
        cardHash,
        costUsd,
        createdAt: now,
        updatedAt: now,
      });
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
  provider?: string;
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
  onProgress?: (progress: IndexProgress) => void,
): Promise<SummaryBatchResult> {
  const conn = await getLadybugConn();
  const semantic = config.semantic;
  if (!semantic) {
    return { generated: 0, skipped: 0, failed: 0, totalCostUsd: 0 };
  }

  const batchSize = semantic.summaryBatchSize ?? 20;
  const maxConcurrency = semantic.summaryMaxConcurrency ?? 5;
  const provider = semantic.summaryProvider ?? "mock";
  const summaryModel = semantic.summaryModel;
  const summaryApiKey = semantic.summaryApiKey;
  const summaryApiBaseUrl = semantic.summaryApiBaseUrl;

  // Resolve the actual provider to determine its name for cache hashing.
  // This must match what generateSummaryWithGuardrails computes internally.
  const resolvedSummaryProvider = createSummaryProvider(provider, {
    summaryModel: summaryModel ?? undefined,
    summaryApiKey: summaryApiKey ?? undefined,
    summaryApiBaseUrl: summaryApiBaseUrl ?? undefined,
  });

  // If provider creation returned null (e.g., misconfigured local provider),
  // skip summary generation entirely to preserve existing summaries.
  if (resolvedSummaryProvider == null) {
    logger.warn(
      `Summary provider "${provider}" could not be created - skipping summary generation for repo ${repoId}. ` +
        "Existing summaries are preserved.",
    );
    const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
    return {
      generated: 0,
      skipped: symbols.length,
      failed: 0,
      totalCostUsd: 0,
    };
  }

  const resolvedProviderName = resolvedSummaryProvider.name;
  const resolvedModelName = summaryModel ?? resolvedProviderName;
  const isMockProvider = resolvedProviderName === "mock";

  // Fetch all symbols for the repo
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  const parseSignatureText = (sym: (typeof symbols)[number]): string | undefined => {
    if (!sym.signatureJson) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(sym.signatureJson) as { text?: string } | string;
      return typeof parsed === "string" ? parsed : (parsed?.text ?? sym.signatureJson);
    } catch (err) {
      logger.debug("Failed to parse signatureJson for summary card hash", {
        symbolId: sym.symbolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return sym.signatureJson;
    }
  };

  // Determine which symbols need a new summary by checking the cache (bulk)
  const cachedSummaries = await ladybugDb.getSummaryCaches(
    conn,
    symbols.map((s) => s.symbolId),
  );
  let needsSummary: typeof symbols = [];
  const preparedInputBySymbolId = new Map<string, PreparedSymbolEmbeddingInput>();

  const summaryRepairs: PendingSymbolSummaryUpdate[] = [];

  for (const sym of symbols) {
    if (isMockProvider && sym.summarySource === "llm") {
      continue;
    }

    // Skip symbols that already have good summaries (JSDoc or LLM-generated).
    // Quality thresholds: JSDoc=1.0, LLM=0.8, NN-direct=0.6, NN-adapted=0.5,
    // heuristic=0.3-0.4. We only regenerate below 0.8.
    if (
      !isCodeFenceOnlySummary(sym.summary) &&
      sym.summaryQuality !== undefined &&
      sym.summaryQuality !== null &&
      sym.summaryQuality >= 0.8
    ) {
      continue;
    }

    if (!isMockProvider) {
      const signatureText = parseSignatureText(sym);
      const cardHash = buildSummaryCardHash({
        symbolName: sym.name,
        kind: sym.kind,
        signature: signatureText,
        astFingerprint: sym.astFingerprint,
        providerName: resolvedProviderName,
        modelName: resolvedModelName,
      });
      const cached = cachedSummaries.get(sym.symbolId);
      if (cached != null && cached.cardHash === cardHash) {
        if (sym.summary !== cached.summary) {
          const metadata = summaryStorageMetadata(cached.provider);
          summaryRepairs.push({
            symbolId: sym.symbolId,
            summary: cached.summary,
            summaryQuality: metadata.quality,
            summarySource: metadata.source,
          });
        }
        continue;
      }
    }

    needsSummary.push(sym);
  }

  if (isMockProvider && needsSummary.length > 0) {
    const preparedInputs = await prepareSymbolEmbeddingInputs(conn, needsSummary, {
      summaryCacheMap: cachedSummaries,
    });
    for (const embeddingInput of preparedInputs) {
      preparedInputBySymbolId.set(embeddingInput.symbol.symbolId, embeddingInput);
    }


    const staleMockSummaries: typeof symbols = [];
    for (const sym of needsSummary) {
      const embeddingInput = preparedInputBySymbolId.get(sym.symbolId);
      const signatureText = embeddingInput?.signatureText ?? parseSignatureText(sym);
      const cardHash = buildSummaryCardHash({
        symbolName: sym.name,
        kind: sym.kind,
        signature: signatureText,
        astFingerprint: sym.astFingerprint,
        providerName: resolvedProviderName,
        modelName: resolvedModelName,
        embeddingInput,
      });
      const cached = cachedSummaries.get(sym.symbolId);
      if (cached != null && cached.cardHash === cardHash) {
        if (sym.summary !== cached.summary) {
          const metadata = summaryStorageMetadata(cached.provider);
          summaryRepairs.push({
            symbolId: sym.symbolId,
            summary: cached.summary,
            summaryQuality: metadata.quality,
            summarySource: metadata.source,
          });
        }
        continue;
      }
      staleMockSummaries.push(sym);
    }
    needsSummary = staleMockSummaries;
  }

  await updateSymbolSummariesInTransaction(summaryRepairs);


  const result: SummaryBatchResult = {
    generated: 0,
    skipped: symbols.length - needsSummary.length,
    failed: 0,
    totalCostUsd: 0,
    provider,
  };

  if (needsSummary.length === 0) {
    return result;
  }

  onProgress?.({ stage: "summaries", current: 0, total: needsSummary.length });

  // Split into batches
  const batches: (typeof needsSummary)[] = [];
  for (let i = 0; i < needsSummary.length; i += batchSize) {
    batches.push(needsSummary.slice(i, i + batchSize));
  }

  // Process batches with limited concurrency
  let batchIndex = 0;
  let symbolsProcessed = 0;

  const processBatch = async (
    batch: typeof needsSummary,
  ): Promise<{ generated: number; failed: number; costUsd: number }> => {
    let batchGenerated = 0;
    let batchFailed = 0;
    let batchCost = 0;
    const generatedRows: PendingGeneratedSummary[] = [];

    for (const sym of batch) {
      try {
        const embeddingInput = preparedInputBySymbolId.get(sym.symbolId);
        const signatureText = embeddingInput?.signatureText ?? parseSignatureText(sym);
        const cardHash = buildSummaryCardHash({
          symbolName: sym.name,
          kind: sym.kind,
          signature: signatureText,
          astFingerprint: sym.astFingerprint,
          providerName: resolvedProviderName,
          modelName: resolvedModelName,
          embeddingInput,
        });

        const genResult = await generateSummaryWithGuardrails({
          symbolName: sym.name,
          symbolId: sym.symbolId,
          kind: sym.kind,
          signature: signatureText,
          astFingerprint: sym.astFingerprint ?? undefined,
          heuristicSummary: sym.summary ?? undefined,
          embeddingInput,
          provider,
          summaryModel: summaryModel ?? undefined,
          summaryApiKey: summaryApiKey ?? undefined,
          summaryApiBaseUrl: summaryApiBaseUrl ?? undefined,
          skipCacheLookup: true,
          persistCache: false,
        });

        const metadata = summaryStorageMetadata(genResult.provider);
        generatedRows.push({
          symbolId: sym.symbolId,
          summary: genResult.summary,
          provider: genResult.provider,
          model: summaryModel ?? genResult.provider,
          cardHash,
          costUsd: genResult.costUsd,
          summaryQuality: metadata.quality,
          summarySource: metadata.source,
        });
        batchCost += genResult.costUsd;
      } catch (err) {
        logger.warn(
          `Failed to generate summary for symbol ${sym.symbolId}: ${String(err)}`,
        );
        batchFailed += 1;
      }
    }

    try {
      await persistGeneratedSummariesInTransaction(generatedRows);
      batchGenerated += generatedRows.length;
    } catch (err) {
      logger.warn(`Failed to persist summary batch: ${String(err)}`);
      batchFailed += generatedRows.length;
    }

    return {
      generated: batchGenerated,
      failed: batchFailed,
      costUsd: batchCost,
    };
  };


  // Run batches with maxConcurrency slots
  while (batchIndex < batches.length) {
    const chunk = batches.slice(batchIndex, batchIndex + maxConcurrency);
    batchIndex += maxConcurrency;

    const settled = await Promise.allSettled(chunk.map((b) => processBatch(b)));

    for (let ci = 0; ci < settled.length; ci++) {
      const outcome = settled[ci];
      const chunkBatchSize = chunk[ci]?.length ?? 0;
      if (outcome.status === "fulfilled") {
        result.generated += outcome.value.generated;
        result.failed += outcome.value.failed;
        result.totalCostUsd += outcome.value.costUsd;
      } else {
        // Entire batch threw - count all as failed
        result.failed += chunkBatchSize;
        logger.warn(`Batch failed entirely: ${String(outcome.reason)}`);
      }
      symbolsProcessed += chunkBatchSize;
      onProgress?.({ stage: "summaries", current: symbolsProcessed, total: needsSummary.length });
    }
  }

  return result;
}
