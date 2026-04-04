import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  createOnnxSession,
  type OnnxEmbeddingSession,
} from "./embeddings-local.js";
import { getModelInfo, applyDocumentPrefix } from "./model-registry.js";
import type { IndexProgress } from "./indexer.js";
import {
  getSymbolEmbeddingFromNode,
  setSymbolEmbeddingOnNode,
} from "../db/ladybug-symbol-embeddings.js";


/** Legacy dimension constant — only used by MockEmbeddingProvider */
export const EMBEDDING_DIMENSION = 64;

export interface EmbeddingScoredSymbol {
  symbol: ladybugDb.SymbolRow;
  lexicalScore: number;
  semanticScore: number;
  finalScore: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  isMockFallback?(): boolean;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedTextDeterministic(text));
  }

  getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  isMockFallback(): boolean {
    return true;
  }
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  private session: OnnxEmbeddingSession | null = null;
  private modelName: string;
  private fallbackToMock = false;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.fallbackToMock) {
      return texts.map((text) => embedTextDeterministic(text));
    }

    try {
      if (!this.session) {
        this.session = await createOnnxSession(this.modelName);
      }
      return await this.session.embed(texts);
    } catch (error) {
      // Graceful degradation: fall back to mock if ONNX/tokenizers unavailable
      logger.warn(
        `Local embedding provider falling back to mock: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.fallbackToMock = true;
      return texts.map((text) => embedTextDeterministic(text));
    }
  }

  getDimension(): number {
    if (this.session) {
      return this.session.dimension;
    }
    if (this.fallbackToMock) {
      return EMBEDDING_DIMENSION;
    }
    try {
      return getModelInfo(this.modelName).dimension;
    } catch (err) {
      logger.debug("Failed to get model dimension, using default", {
        modelName: this.modelName,
        fallbackDimension: EMBEDDING_DIMENSION,
        error: err instanceof Error ? err.message : String(err),
      });
      return EMBEDDING_DIMENSION;
    }
  }

  isMockFallback(): boolean {
    return this.fallbackToMock;
  }
}

class ApiEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    // API mode is intentionally deterministic for testability in OSS builds.
    return texts.map((text) => embedTextDeterministic(text));
  }

  getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  isMockFallback(): boolean {
    // API provider currently uses the same deterministic mock vectors.
    // Mark as mock so embeddings are stored under "mock-fallback" rather
    // than the configured model name, preventing dimension-mismatch if
    // the user later switches to a real local provider.
    return true;
  }
}

function embedTextDeterministic(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    tokens.push(text.toLowerCase());
  }

  const vec = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const token of tokens) {
    const seedHex = hashContent(token);
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      const offset = (i * 2) % Math.max(2, seedHex.length - 1);
      const b = Number.parseInt(seedHex.slice(offset, offset + 2), 16) || 0;
      const signed = (b / 255) * 2 - 1;
      vec[i] += signed;
    }
  }
  return normalizeVector(vec);
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 1e-9) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-9) {
    return 0;
  }
  return dot / denom;
}

function toFloat16Blob(vector: number[]): string {
  const ints = new Int16Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    ints[i] = Math.max(-32767, Math.min(32767, Math.round(vector[i] * 10000)));
  }
  return Buffer.from(ints.buffer).toString("base64");
}

function buildCardHash(
  symbol: ladybugDb.SymbolRow,
  extraContext?: string,
): string {
  return hashContent(
    [
      symbol.symbolId,
      symbol.name,
      symbol.kind,
      symbol.astFingerprint,
      symbol.summary ?? "",
      symbol.signatureJson ?? "",
      extraContext ?? "",
    ].join("|"),
  );
}

function parseSignatureText(signatureJson: string | null): string | null {
  if (!signatureJson) return null;
  try {
    const parsed = JSON.parse(signatureJson) as { text?: string } | string;
    return typeof parsed === "string"
      ? parsed
      : (parsed?.text ?? signatureJson);
  } catch (err) {
    logger.debug("Failed to parse signature JSON, using raw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return signatureJson;
  }
}

export function getEmbeddingProvider(
  provider: "api" | "local" | "mock",
  model?: string,
): EmbeddingProvider {
  switch (provider) {
    case "local":
      return new LocalEmbeddingProvider(model ?? "all-MiniLM-L6-v2");
    case "api":
      return new ApiEmbeddingProvider();
    case "mock":
    default:
      return new MockEmbeddingProvider();
  }
}

/**
 * For MiniLM (general text model): name + kind + signature + summary.
 * Formats as natural language because MiniLM is a text model.
 */
export function buildRawEmbeddingText(symbol: ladybugDb.SymbolRow): string {
  const parts = [`${symbol.name} (${symbol.kind})`];
  const signatureText = parseSignatureText(symbol.signatureJson);
  if (signatureText) {
    parts.push(signatureText);
  }
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join("\n");
}

export async function refreshSymbolEmbeddings(params: {
  repoId: string;
  provider: "api" | "local" | "mock";
  model: string;
  symbols?: ladybugDb.SymbolRow[];
  onProgress?: (progress: IndexProgress) => void;
}): Promise<{ embedded: number; skipped: number }> {
  const modelName = params.model ?? "all-MiniLM-L6-v2";
  const provider = getEmbeddingProvider(params.provider, modelName);
  const conn = await getLadybugConn();
  const symbols =
    params.symbols ?? (await ladybugDb.getSymbolsByRepo(conn, params.repoId));
  let embedded = 0;
  let skipped = 0;

  // All text-based models benefit from LLM summaries when available.
  const summaryCacheMap = await ladybugDb.getSummaryCaches(
    conn,
    symbols.map((s) => s.symbolId),
  );

  params.onProgress?.({ stage: "embeddings", current: 0, total: symbols.length });

  for (let si = 0; si < symbols.length; si++) {
    if (si > 0 && si % 25 === 0) {
      params.onProgress?.({ stage: "embeddings", current: si, total: symbols.length });
    }
    const symbol = symbols[si];
    // Text construction (all models are text-based):
    // - Without summaries (Low/Medium): embed raw symbol text (name + kind + signature)
    // - With summaries (High): embed LLM summary when available (better for all text models)
    let text: string;
    {
      const cachedSummary = summaryCacheMap.get(symbol.symbolId);
      // Only use cached LLM summary if it was generated by a real provider AND
      // the summary's cardHash matches the current symbol+provider state. The
      // summary cache hash includes provider+model, so we reconstruct with the
      // cached entry's own provider and model to check freshness.
      const hasLLMSummary =
        cachedSummary &&
        cachedSummary.provider !== "mock" &&
        cachedSummary.cardHash ===
          hashContent(
            [
              symbol.name,
              symbol.kind ?? "",
              parseSignatureText(symbol.signatureJson) ?? "",
              symbol.astFingerprint ?? "",
              cachedSummary.provider,
              cachedSummary.model,
            ].join("|"),
          );
      if (hasLLMSummary) {
        text = `${symbol.name} (${symbol.kind}): ${cachedSummary.summary}`;
      } else if (cachedSummary && cachedSummary.provider !== "mock") {
        // Stale LLM summary exists — symbol.summary may contain an outdated
        // LLM-generated summary preserved across reindex. Build text from
        // stable fields only to avoid encoding stale information.
        const parts = [`${symbol.name} (${symbol.kind})`];
        const signatureText = parseSignatureText(symbol.signatureJson);
        if (signatureText) parts.push(signatureText);
        text = parts.join("\n");
      } else {
        text = buildRawEmbeddingText(symbol);
      }
    }

    const prefixedText = applyDocumentPrefix(modelName, text);
    const cardHash = buildCardHash(symbol, prefixedText);
    let storageModel = provider.isMockFallback?.()
      ? "mock-fallback"
      : modelName;
    // Mock-fallback vectors must not be persisted to Symbol node properties
    // (the model is not in EMBEDDING_MODELS, so property-name resolution would throw).
    if (storageModel === "mock-fallback") {
      skipped += 1;
      continue;
    }
    const existing = await getSymbolEmbeddingFromNode(conn, symbol.symbolId, storageModel);
    if (existing && existing.cardHash === cardHash) {
      skipped += 1;
      continue;
    }

    const [vector] = await provider.embed([prefixedText]);
    storageModel = provider.isMockFallback?.() ? "mock-fallback" : modelName;
    // Guard: if provider degraded to mock during embed, skip storage.
    if (storageModel === "mock-fallback") {
      skipped += 1;
      continue;
    }
    // Re-check after embed in case provider changed fallback status
    const existingAfterEmbed = await getSymbolEmbeddingFromNode(conn, symbol.symbolId, storageModel);
    if (existingAfterEmbed && existingAfterEmbed.cardHash === cardHash) {
      skipped += 1;
      continue;
    }
    await withWriteConn(async (wConn) => {
      await setSymbolEmbeddingOnNode(
        wConn,
        symbol.symbolId,
        storageModel,
        toFloat16Blob(vector),
        cardHash,
      );
    });
    embedded += 1;
  }

  params.onProgress?.({ stage: "embeddings", current: symbols.length, total: symbols.length });
  return { embedded, skipped };
}
