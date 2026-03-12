import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { hashContent } from "../util/hashing.js";
import { logger } from "../util/logger.js";
import {
  createOnnxSession,
  type OnnxEmbeddingSession,
} from "./embeddings-local.js";
import { getModelInfo } from "./model-registry.js";

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
    } catch {
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

function cosineSimilarity(a: number[], b: number[]): number {
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

function fromFloat16Blob(blob: string): number[] {
  if (!blob) {
    return [];
  }
  const buffer = Buffer.from(blob, "base64");
  const view = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 2,
  );
  const vector = new Array<number>(view.length);
  for (let i = 0; i < view.length; i++) {
    vector[i] = view[i] / 10000;
  }
  return normalizeVector(vector);
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
  } catch {
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
function buildRawEmbeddingText(symbol: ladybugDb.SymbolRow): string {
  const parts = [`${symbol.name} (${symbol.kind})`];
  const signatureText = parseSignatureText(symbol.signatureJson);
  if (signatureText) {
    parts.push(signatureText);
  }
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join("\n");
}

/**
 * For nomic-embed-code (code-trained model): include more code context.
 * Formats as pseudo-code because nomic was trained on code and responds better
 * to code-like formatting.
 */
function buildCodeEmbeddingText(symbol: ladybugDb.SymbolRow): string {
  const parts = [`${symbol.kind} ${symbol.name}`];
  const signatureText = parseSignatureText(symbol.signatureJson);
  if (signatureText) {
    parts.push(signatureText);
  }
  // fileId is available but filePath requires a join — omit for now
  // since the model gets enough context from kind + name + signature
  if (symbol.summary) parts.push(`// ${symbol.summary}`);
  return parts.join("\n");
}

export async function refreshSymbolEmbeddings(params: {
  repoId: string;
  provider: "api" | "local" | "mock";
  model: string;
  symbols?: ladybugDb.SymbolRow[];
}): Promise<{ embedded: number; skipped: number }> {
  const modelName = params.model ?? "all-MiniLM-L6-v2";
  const isCodeModel = modelName === "nomic-embed-code-v1";
  const provider = getEmbeddingProvider(params.provider, modelName);
  const conn = await getLadybugConn();
  const symbols =
    params.symbols ?? (await ladybugDb.getSymbolsByRepo(conn, params.repoId));
  let embedded = 0;
  let skipped = 0;

  const summaryCacheMap = isCodeModel
    ? new Map<
        string,
        { summary: string; provider: string; model: string; cardHash: string }
      >()
    : await ladybugDb.getSummaryCaches(
        conn,
        symbols.map((s) => s.symbolId),
      );

  for (const symbol of symbols) {
    // Tier-aware text construction:
    // - nomic-embed-code: embed raw code text (model understands code natively)
    // - MiniLM low tier: embed raw symbol text
    // - MiniLM high tier: embed LLM summary when available
    let text: string;
    if (isCodeModel) {
      text = buildCodeEmbeddingText(symbol);
    } else {
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

    const cardHash = buildCardHash(symbol, text);
    const existing = await ladybugDb.getSymbolEmbedding(conn, symbol.symbolId);
    let storageModel = provider.isMockFallback?.()
      ? "mock-fallback"
      : modelName;
    if (
      existing &&
      existing.model === storageModel &&
      existing.cardHash === cardHash
    ) {
      skipped += 1;
      continue;
    }
    if (
      existing &&
      existing.model === modelName &&
      existing.cardHash === cardHash
    ) {
      skipped += 1;
      continue;
    }

    const [vector] = await provider.embed([text]);
    storageModel = provider.isMockFallback?.()
      ? "mock-fallback"
      : modelName;
    if (
      existing &&
      existing.model === storageModel &&
      existing.cardHash === cardHash
    ) {
      skipped += 1;
      continue;
    }
    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertSymbolEmbedding(wConn, {
        symbolId: symbol.symbolId,
        model: storageModel,
        embeddingVector: toFloat16Blob(vector),
        version: "v1",
        cardHash,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    embedded += 1;
  }

  return { embedded, skipped };
}

export async function rerankByEmbeddings(params: {
  query: string;
  symbols: Array<{ symbol: ladybugDb.SymbolRow; lexicalScore: number }>;
  provider: "api" | "local" | "mock";
  alpha: number;
  model: string;
}): Promise<EmbeddingScoredSymbol[]> {
  if (params.symbols.length === 0) {
    return [];
  }

  const alpha = Math.max(0, Math.min(1, params.alpha));
  const provider = getEmbeddingProvider(params.provider, params.model);
  const queryEmbedding = (await provider.embed([params.query]))[0];

  // After embedding the query, determine the actual model used.
  // If the provider fell back to mock, the query embedding is 64-dim mock vectors,
  // so we must only compare against other mock-fallback embeddings.
  const expectedModel = provider.isMockFallback?.()
    ? "mock-fallback"
    : params.model;

  const conn = await getLadybugConn();
  const embeddingMap = await ladybugDb.getSymbolEmbeddings(
    conn,
    params.symbols.map((item) => item.symbol.symbolId),
  );

  const wrongModel: string[] = [];
  for (const [symbolId, row] of embeddingMap) {
    if (row.model !== expectedModel) {
      wrongModel.push(symbolId);
    }
  }
  for (const id of wrongModel) {
    embeddingMap.delete(id);
  }

  // Validate cardHash freshness — stale embeddings (e.g., text construction
  // changed due to model switch while both fall back to mock-fallback) should
  // be treated as missing and refreshed on demand.
  const isCodeModelRerank = params.model === "nomic-embed-code-v1";
  const symbolById = new Map(
    params.symbols.map((item) => [item.symbol.symbolId, item.symbol]),
  );
  const summaryCacheForRerank = isCodeModelRerank
    ? new Map<
        string,
        { summary: string; provider: string; model: string; cardHash: string }
      >()
    : await ladybugDb.getSummaryCaches(conn, [...embeddingMap.keys()]);
  const staleHash: string[] = [];
  for (const [symbolId, row] of embeddingMap) {
    const sym = symbolById.get(symbolId);
    if (!sym) continue;
    let text: string;
    if (isCodeModelRerank) {
      text = buildCodeEmbeddingText(sym);
    } else {
      const cachedSummary = summaryCacheForRerank.get(symbolId);
      const hasLLMSummary =
        cachedSummary &&
        cachedSummary.provider !== "mock" &&
        cachedSummary.cardHash ===
          hashContent(
            [
              sym.name,
              sym.kind ?? "",
              parseSignatureText(sym.signatureJson) ?? "",
              sym.astFingerprint ?? "",
              cachedSummary.provider,
              cachedSummary.model,
            ].join("|"),
          );
      if (hasLLMSummary) {
        text = `${sym.name} (${sym.kind}): ${cachedSummary.summary}`;
      } else if (cachedSummary && cachedSummary.provider !== "mock") {
        const parts = [`${sym.name} (${sym.kind})`];
        const signatureText = parseSignatureText(sym.signatureJson);
        if (signatureText) parts.push(signatureText);
        text = parts.join("\n");
      } else {
        text = buildRawEmbeddingText(sym);
      }
    }
    const expectedHash = buildCardHash(sym, text);
    if (row.cardHash !== expectedHash) {
      staleHash.push(symbolId);
    }
  }
  for (const id of staleHash) {
    embeddingMap.delete(id);
  }

  const missing = params.symbols
    .map((item) => item.symbol)
    .filter((symbol) => !embeddingMap.has(symbol.symbolId));

  if (missing.length > 0) {
    await refreshSymbolEmbeddings({
      repoId: missing[0].repoId,
      provider: params.provider,
      model: params.model,
      symbols: missing,
    });
    const refreshed = await ladybugDb.getSymbolEmbeddings(
      conn,
      missing.map((symbol) => symbol.symbolId),
    );
    for (const [key, value] of refreshed) {
      // Only merge rows matching expectedModel — the refresh provider may
      // have made a different fallback decision than the query provider.
      if (value.model === expectedModel) {
        embeddingMap.set(key, value);
      }
    }
  }

  return params.symbols
    .map((item) => {
      const embeddingRow = embeddingMap.get(item.symbol.symbolId);
      const semanticScore = embeddingRow
        ? cosineSimilarity(
            queryEmbedding,
            fromFloat16Blob(embeddingRow.embeddingVector),
          )
        : 0;
      const finalScore =
        alpha * item.lexicalScore + (1 - alpha) * semanticScore;
      return {
        symbol: item.symbol,
        lexicalScore: item.lexicalScore,
        semanticScore,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
